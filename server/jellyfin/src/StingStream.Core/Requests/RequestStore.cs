using System;
using System.Collections.Generic;
using System.Data;
using System.Globalization;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using StingStream.Core.Data;

namespace StingStream.Core.Requests;

/// <summary>
/// Everything M6 stores: requests, their event trail, the per-group policy, per-member trust and
/// quota, and the in-app notification queue.
/// </summary>
/// <remarks>
/// <para>
/// The five tables live in <c>core.db</c> alongside the rest of StingStream's state, but the DDL is
/// <em>here</em> rather than in <see cref="CoreDatabase.ApplySchema"/>. That is a deliberate
/// departure from where the other tables are declared, and the reason is the shared checkout: this
/// file is M6's alone, while <c>CoreDatabase.cs</c> is edited by everyone, and a schema addition is
/// exactly the kind of change that ends up half-committed across two agents (see
/// <c>docs/CONTRIBUTING.md</c> rule 2). Every statement is <c>IF NOT EXISTS</c> and
/// <see cref="EnsureSchema"/> is idempotent and cheap, so the effect on the database is identical.
/// </para>
/// <para>
/// Requests from <em>other</em> nodes are stored here too, with <c>mine = 0</c>. A node that is
/// going to fulfil somebody else's request needs somewhere to keep what it knows about it, and the
/// alternative — asking the mesh every time — would mean the fulfilment loop could not survive the
/// mesh restarting mid-download.
/// </para>
/// </remarks>
public sealed class RequestStore
{
    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private readonly CoreDatabase _db;
    private readonly object _schemaLock = new();
    private bool _schemaReady;

    public RequestStore(CoreDatabase db)
    {
        _db = db;
    }

    /// <summary>Create M6's tables if they are not there. Idempotent; safe to call on every use.</summary>
    public void EnsureSchema()
    {
        if (_schemaReady)
        {
            return;
        }

        lock (_schemaLock)
        {
            if (_schemaReady)
            {
                return;
            }

            using var c = _db.Open();
            CoreDatabase.Execute(
                c,
                """
                -- One row per request this node knows about. `mine` distinguishes the ones made
                -- here from the ones heard over gossip, which matters because only the origin may
                -- approve, decline or delete one.
                CREATE TABLE IF NOT EXISTS requests (
                    id                  TEXT PRIMARY KEY,
                    group_id            TEXT NOT NULL DEFAULT '',
                    kind                TEXT NOT NULL,
                    item_key            TEXT NOT NULL,
                    provider            TEXT NOT NULL DEFAULT '',
                    provider_id         INTEGER NOT NULL DEFAULT 0,
                    title               TEXT NOT NULL DEFAULT '',
                    year                INTEGER,
                    poster_url          TEXT,
                    seasons             TEXT NOT NULL DEFAULT '[]',
                    state               TEXT NOT NULL,
                    requested_by        TEXT NOT NULL DEFAULT '',
                    requested_by_name   TEXT NOT NULL DEFAULT '',
                    requested_at        TEXT NOT NULL,
                    decided_by          TEXT,
                    decided_by_name     TEXT,
                    decided_at          TEXT,
                    fulfilling_node     TEXT,
                    fulfilling_node_name TEXT,
                    note                TEXT NOT NULL DEFAULT '',
                    mine                INTEGER NOT NULL DEFAULT 1,
                    published           INTEGER NOT NULL DEFAULT 0,
                    updated_at          TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ix_requests_state ON requests (state);
                CREATE INDEX IF NOT EXISTS ix_requests_user ON requests (requested_by);
                CREATE INDEX IF NOT EXISTS ix_requests_item ON requests (item_key);

                -- The trail. Every state change writes one, so "why is this still pending" has an
                -- answer that does not depend on the log file still existing.
                CREATE TABLE IF NOT EXISTS request_events (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    request_id TEXT NOT NULL,
                    state      TEXT NOT NULL,
                    actor      TEXT NOT NULL DEFAULT '',
                    note       TEXT NOT NULL DEFAULT '',
                    at         TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ix_request_events_request ON request_events (request_id);

                -- One row per group. The empty group id is this node's default, which is what a
                -- node that has not joined anything yet reads and writes.
                CREATE TABLE IF NOT EXISTS request_policy (
                    group_id       TEXT PRIMARY KEY,
                    auto_approve   TEXT NOT NULL DEFAULT 'trusted',
                    weekly_quota   INTEGER NOT NULL DEFAULT 0,
                    minimum_height INTEGER NOT NULL DEFAULT 0,
                    updated_at     TEXT NOT NULL
                );

                -- Per-member trust and quota. Absent means "not trusted, group quota", which is
                -- what every member starts as.
                CREATE TABLE IF NOT EXISTS request_trust (
                    user_id      TEXT PRIMARY KEY,
                    trusted      INTEGER NOT NULL DEFAULT 0,
                    weekly_quota INTEGER NOT NULL DEFAULT 0,
                    updated_at   TEXT NOT NULL
                );

                -- In-app notifications. Polled by the app; also mirrored into Jellyfin's own
                -- activity log and pushed to live sessions -- see RequestNotifier.
                CREATE TABLE IF NOT EXISTS notifications (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id    TEXT NOT NULL,
                    kind       TEXT NOT NULL,
                    title      TEXT NOT NULL,
                    body       TEXT NOT NULL DEFAULT '',
                    request_id TEXT,
                    read       INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications (user_id, read);
                """);
            _schemaReady = true;
        }
    }

    // --- requests ----------------------------------------------------------

    /// <summary>Every request, newest first.</summary>
    /// <returns>The rows.</returns>
    public IReadOnlyList<RequestRow> All()
    {
        EnsureSchema();
        return _db.Read(c => CoreDatabase.Query(c, Select + " ORDER BY requested_at DESC;", Map));
    }

    /// <summary>Requests originated on this node, newest first.</summary>
    /// <returns>The rows.</returns>
    public IReadOnlyList<RequestRow> Mine()
    {
        EnsureSchema();
        return _db.Read(c => CoreDatabase.Query(c, Select + " WHERE mine = 1 ORDER BY requested_at DESC;", Map));
    }

    /// <summary>One request by id.</summary>
    /// <param name="id">The request id.</param>
    /// <returns>The row, or null.</returns>
    public RequestRow? Get(string id)
    {
        EnsureSchema();
        var rows = _db.Read(c => CoreDatabase.Query(c, Select + " WHERE id = $i;", Map, ("$i", id)));
        return rows.Count > 0 ? rows[0] : null;
    }

    /// <summary>
    /// The open request for a title, if this node already has one.
    /// </summary>
    /// <param name="itemKey">The item key, or the series prefix.</param>
    /// <returns>The row, or null.</returns>
    /// <remarks>
    /// The de-duplication that stops five people requesting the same film on Sunday evening from
    /// becoming five downloads. Keyed on the item key, so the two halves of a series request — one
    /// person wanting season 1 and another season 2 — collapse onto one request whose season list
    /// grows. Which is right: Sonarr monitors seasons on one series, not one series per season.
    /// </remarks>
    public RequestRow? OpenForItem(string itemKey)
    {
        EnsureSchema();
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE item_key = $k AND state IN ('pending','approved','fulfilling') "
                   + "ORDER BY requested_at DESC;",
            Map,
            ("$k", itemKey)));
        return rows.Count > 0 ? rows[0] : null;
    }

    /// <summary>The most recent request for a title in any state.</summary>
    /// <param name="itemKey">The item key.</param>
    /// <returns>The row, or null.</returns>
    public RequestRow? LatestForItem(string itemKey)
    {
        EnsureSchema();
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE item_key = $k ORDER BY requested_at DESC;",
            Map,
            ("$k", itemKey)));
        return rows.Count > 0 ? rows[0] : null;
    }

    /// <summary>Requests in one state.</summary>
    /// <param name="state">The state.</param>
    /// <returns>The rows.</returns>
    public IReadOnlyList<RequestRow> InState(string state)
    {
        EnsureSchema();
        return _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE state = $s ORDER BY requested_at;",
            Map,
            ("$s", state)));
    }

    /// <summary>Insert or replace a request.</summary>
    /// <param name="row">The row.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The row, with its timestamp stamped.</returns>
    public async Task<RequestRow> SaveAsync(RequestRow row, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);
        EnsureSchema();
        row.UpdatedAt = Now();
        await _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO requests
                    (id, group_id, kind, item_key, provider, provider_id, title, year, poster_url,
                     seasons, state, requested_by, requested_by_name, requested_at, decided_by,
                     decided_by_name, decided_at, fulfilling_node, fulfilling_node_name, note, mine,
                     updated_at)
                VALUES ($id, $g, $k, $ik, $p, $pid, $t, $y, $pu, $s, $st, $rb, $rbn, $ra, $db, $dbn,
                        $da, $fn, $fnn, $n, $m, $u)
                ON CONFLICT(id) DO UPDATE SET
                    group_id = excluded.group_id, kind = excluded.kind,
                    item_key = excluded.item_key, provider = excluded.provider,
                    provider_id = excluded.provider_id, title = excluded.title,
                    year = excluded.year, poster_url = excluded.poster_url,
                    seasons = excluded.seasons, state = excluded.state,
                    requested_by = excluded.requested_by,
                    requested_by_name = excluded.requested_by_name,
                    requested_at = excluded.requested_at, decided_by = excluded.decided_by,
                    decided_by_name = excluded.decided_by_name, decided_at = excluded.decided_at,
                    fulfilling_node = excluded.fulfilling_node,
                    fulfilling_node_name = excluded.fulfilling_node_name,
                    note = excluded.note, mine = excluded.mine, updated_at = excluded.updated_at;
                """,
                ("$id", row.Id),
                ("$g", row.Group),
                ("$k", row.Kind),
                ("$ik", row.ItemKey),
                ("$p", row.Provider),
                ("$pid", row.ProviderId),
                ("$t", row.Title),
                ("$y", row.Year),
                ("$pu", row.PosterUrl),
                ("$s", JsonSerializer.Serialize(row.Seasons, _json)),
                ("$st", row.State),
                ("$rb", row.RequestedBy),
                ("$rbn", row.RequestedByName),
                ("$ra", row.RequestedAt),
                ("$db", row.DecidedBy),
                ("$dbn", row.DecidedByName),
                ("$da", row.DecidedAt),
                ("$fn", row.FulfillingNode),
                ("$fnn", row.FulfillingNodeName),
                ("$n", row.Note),
                ("$m", row.Mine ? 1 : 0),
                ("$u", row.UpdatedAt)),
            cancellationToken).ConfigureAwait(false);
        return row;
    }

    /// <summary>Delete a request and its trail.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task DeleteAsync(string id, CancellationToken cancellationToken)
    {
        EnsureSchema();
        return _db.WriteAsync(
            c =>
            {
                CoreDatabase.Execute(c, "DELETE FROM request_events WHERE request_id = $i;", ("$i", id));
                CoreDatabase.Execute(c, "DELETE FROM notifications WHERE request_id = $i;", ("$i", id));
                CoreDatabase.Execute(c, "DELETE FROM requests WHERE id = $i;", ("$i", id));
            },
            cancellationToken);
    }

    /// <summary>Whether a request has been gossiped to the group yet.</summary>
    /// <param name="id">The request id.</param>
    /// <returns>True when it has.</returns>
    public bool IsPublished(string id)
    {
        EnsureSchema();
        return _db.Read(c => CoreDatabase.ScalarLong(
            c,
            "SELECT published FROM requests WHERE id = $i;",
            ("$i", id))) == 1;
    }

    /// <summary>Record that a request has been gossiped.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="published">Whether it is published.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task SetPublishedAsync(string id, bool published, CancellationToken cancellationToken)
    {
        EnsureSchema();
        return _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                "UPDATE requests SET published = $p WHERE id = $i;",
                ("$i", id),
                ("$p", published ? 1 : 0)),
            cancellationToken);
    }

    /// <summary>
    /// How many requests a member has made in the last seven days, not counting declined ones.
    /// </summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <returns>The count.</returns>
    /// <remarks>
    /// Declined requests are excluded on purpose. A quota is a limit on what a member may cost the
    /// group, and a request an administrator refused cost it nothing — charging them for a decision
    /// somebody else made is the sort of rule that makes people stop using a feature.
    /// </remarks>
    public int RequestsThisWeek(string userId)
    {
        EnsureSchema();
        var since = DateTime.UtcNow.AddDays(-7).ToString("O", CultureInfo.InvariantCulture);
        return (int)(_db.Read(c => CoreDatabase.ScalarLong(
            c,
            "SELECT COUNT(*) FROM requests WHERE requested_by = $u AND requested_at >= $s "
            + "AND state <> 'declined';",
            ("$u", userId),
            ("$s", since))) ?? 0);
    }

    // --- events ------------------------------------------------------------

    /// <summary>Append to a request's trail.</summary>
    /// <param name="requestId">The request id.</param>
    /// <param name="state">The state moved into.</param>
    /// <param name="actor">Who or what did it.</param>
    /// <param name="note">Why.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task AddEventAsync(
        string requestId,
        string state,
        string actor,
        string note,
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        return _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                "INSERT INTO request_events (request_id, state, actor, note, at) "
                + "VALUES ($r, $s, $a, $n, $t);",
                ("$r", requestId),
                ("$s", state),
                ("$a", actor),
                ("$n", note),
                ("$t", Now())),
            cancellationToken);
    }

    /// <summary>One request's trail, oldest first.</summary>
    /// <param name="requestId">The request id.</param>
    /// <returns>The events.</returns>
    public IReadOnlyList<RequestEvent> Events(string requestId)
    {
        EnsureSchema();
        return _db.Read(c => CoreDatabase.Query(
            c,
            "SELECT id, request_id, state, actor, note, at FROM request_events "
            + "WHERE request_id = $r ORDER BY id;",
            r => new RequestEvent
            {
                Id = r.GetInt64(0),
                RequestId = r.GetString(1),
                State = r.GetString(2),
                Actor = r.GetString(3),
                Note = r.GetString(4),
                At = r.GetString(5),
            },
            ("$r", requestId)));
    }

    // --- policy ------------------------------------------------------------

    /// <summary>The policy for a group, or this node's default when the group has none.</summary>
    /// <param name="group">The group id, or empty.</param>
    /// <returns>The policy.</returns>
    public RequestPolicy Policy(string? group)
    {
        EnsureSchema();
        var key = group ?? string.Empty;
        var rows = _db.Read(c => CoreDatabase.Query(c, PolicySelect + " WHERE group_id = $g;", MapPolicy, ("$g", key)));
        if (rows.Count > 0)
        {
            return rows[0];
        }

        if (key.Length > 0)
        {
            // Fall back to the node default rather than inventing one, so a group created after the
            // administrator set a policy inherits it instead of quietly reverting to `trusted`.
            var fallback = _db.Read(c => CoreDatabase.Query(
                c,
                PolicySelect + " WHERE group_id = '';",
                MapPolicy));
            if (fallback.Count > 0)
            {
                fallback[0].Group = key;
                return fallback[0];
            }
        }

        return new RequestPolicy { Group = key, UpdatedAt = Now() };
    }

    /// <summary>Store a group's policy.</summary>
    /// <param name="policy">The policy.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The stored policy.</returns>
    public async Task<RequestPolicy> SavePolicyAsync(RequestPolicy policy, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(policy);
        EnsureSchema();
        policy.UpdatedAt = Now();
        await _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO request_policy (group_id, auto_approve, weekly_quota, minimum_height, updated_at)
                VALUES ($g, $a, $q, $h, $u)
                ON CONFLICT(group_id) DO UPDATE SET
                    auto_approve = excluded.auto_approve, weekly_quota = excluded.weekly_quota,
                    minimum_height = excluded.minimum_height, updated_at = excluded.updated_at;
                """,
                ("$g", policy.Group),
                ("$a", policy.AutoApprove),
                ("$q", policy.WeeklyQuota),
                ("$h", policy.MinimumHeight),
                ("$u", policy.UpdatedAt)),
            cancellationToken).ConfigureAwait(false);
        return policy;
    }

    // --- trust -------------------------------------------------------------

    /// <summary>Whether a member is trusted, and their own quota if they have one.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <returns>Trust and quota.</returns>
    public (bool Trusted, int WeeklyQuota) Trust(string userId)
    {
        EnsureSchema();
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            "SELECT trusted, weekly_quota FROM request_trust WHERE user_id = $u;",
            r => (r.GetInt64(0) != 0, (int)r.GetInt64(1)),
            ("$u", userId)));
        return rows.Count > 0 ? rows[0] : (false, 0);
    }

    /// <summary>Set a member's trust flag and personal quota.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <param name="trusted">Whether they are trusted.</param>
    /// <param name="weeklyQuota">Their own quota, or zero for the group's.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task SetTrustAsync(string userId, bool trusted, int weeklyQuota, CancellationToken cancellationToken)
    {
        EnsureSchema();
        return _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO request_trust (user_id, trusted, weekly_quota, updated_at)
                VALUES ($u, $t, $q, $a)
                ON CONFLICT(user_id) DO UPDATE SET
                    trusted = excluded.trusted, weekly_quota = excluded.weekly_quota,
                    updated_at = excluded.updated_at;
                """,
                ("$u", userId),
                ("$t", trusted ? 1 : 0),
                ("$q", weeklyQuota),
                ("$a", Now())),
            cancellationToken);
    }

    // --- notifications -----------------------------------------------------

    /// <summary>Queue one in-app notification.</summary>
    /// <param name="row">The notification.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task AddNotificationAsync(NotificationRow row, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);
        EnsureSchema();
        return _db.WriteAsync(
            c =>
            {
                CoreDatabase.Execute(
                    c,
                    "INSERT INTO notifications (user_id, kind, title, body, request_id, created_at) "
                    + "VALUES ($u, $k, $t, $b, $r, $c);",
                    ("$u", row.UserId),
                    ("$k", row.Kind),
                    ("$t", row.Title),
                    ("$b", row.Body),
                    ("$r", row.RequestId),
                    ("$c", Now()));

                // Bounded per user. A notification list is a tail, not an archive, and the request
                // itself is the durable record.
                CoreDatabase.Execute(
                    c,
                    """
                    DELETE FROM notifications WHERE user_id = $u AND id NOT IN (
                        SELECT id FROM notifications WHERE user_id = $u ORDER BY id DESC LIMIT 200
                    );
                    """,
                    ("$u", row.UserId));
            },
            cancellationToken);
    }

    /// <summary>One member's notifications, newest first.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <param name="unreadOnly">Only the unread ones.</param>
    /// <param name="limit">How many at most.</param>
    /// <returns>The notifications.</returns>
    public IReadOnlyList<NotificationRow> Notifications(string userId, bool unreadOnly, int limit)
    {
        EnsureSchema();
        var where = unreadOnly ? " AND read = 0" : string.Empty;
        return _db.Read(c => CoreDatabase.Query(
            c,
            "SELECT id, user_id, kind, title, body, request_id, read, created_at FROM notifications "
            + "WHERE user_id = $u" + where + " ORDER BY id DESC LIMIT $l;",
            r => new NotificationRow
            {
                Id = r.GetInt64(0),
                UserId = r.GetString(1),
                Kind = r.GetString(2),
                Title = r.GetString(3),
                Body = r.GetString(4),
                RequestId = r.IsDBNull(5) ? null : r.GetString(5),
                Read = r.GetInt64(6) != 0,
                CreatedAt = r.GetString(7),
            },
            ("$u", userId),
            ("$l", Math.Clamp(limit, 1, 200))));
    }

    /// <summary>How many unread notifications a member has.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <returns>The count.</returns>
    public int UnreadCount(string userId)
    {
        EnsureSchema();
        return (int)(_db.Read(c => CoreDatabase.ScalarLong(
            c,
            "SELECT COUNT(*) FROM notifications WHERE user_id = $u AND read = 0;",
            ("$u", userId))) ?? 0);
    }

    /// <summary>Mark notifications read.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <param name="ids">The ids, or empty for all of theirs.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task MarkReadAsync(string userId, IReadOnlyList<long> ids, CancellationToken cancellationToken)
    {
        EnsureSchema();
        return _db.WriteAsync(
            c =>
            {
                if (ids.Count == 0)
                {
                    CoreDatabase.Execute(
                        c,
                        "UPDATE notifications SET read = 1 WHERE user_id = $u;",
                        ("$u", userId));
                    return;
                }

                foreach (var id in ids)
                {
                    CoreDatabase.Execute(
                        c,
                        "UPDATE notifications SET read = 1 WHERE user_id = $u AND id = $i;",
                        ("$u", userId),
                        ("$i", id));
                }
            },
            cancellationToken);
    }

    // --- mapping -----------------------------------------------------------

    private const string Select =
        "SELECT id, group_id, kind, item_key, provider, provider_id, title, year, poster_url, "
        + "seasons, state, requested_by, requested_by_name, requested_at, decided_by, "
        + "decided_by_name, decided_at, fulfilling_node, fulfilling_node_name, note, mine, "
        + "updated_at FROM requests";

    private const string PolicySelect =
        "SELECT group_id, auto_approve, weekly_quota, minimum_height, updated_at FROM request_policy";

    private static string Now() => DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);

    private static RequestRow Map(IDataRecord r) => new()
    {
        Id = r.GetString(0),
        Group = r.GetString(1),
        Kind = r.GetString(2),
        ItemKey = r.GetString(3),
        Provider = r.GetString(4),
        ProviderId = (int)r.GetInt64(5),
        Title = r.GetString(6),
        Year = r.IsDBNull(7) ? null : (int)r.GetInt64(7),
        PosterUrl = r.IsDBNull(8) ? null : r.GetString(8),
        Seasons = Seasons(r.GetString(9)),
        State = r.GetString(10),
        RequestedBy = r.GetString(11),
        RequestedByName = r.GetString(12),
        RequestedAt = r.GetString(13),
        DecidedBy = r.IsDBNull(14) ? null : r.GetString(14),
        DecidedByName = r.IsDBNull(15) ? null : r.GetString(15),
        DecidedAt = r.IsDBNull(16) ? null : r.GetString(16),
        FulfillingNode = r.IsDBNull(17) ? null : r.GetString(17),
        FulfillingNodeName = r.IsDBNull(18) ? null : r.GetString(18),
        Note = r.GetString(19),
        Mine = r.GetInt64(20) != 0,
        UpdatedAt = r.GetString(21),
    };

    private static RequestPolicy MapPolicy(IDataRecord r) => new()
    {
        Group = r.GetString(0),
        AutoApprove = r.GetString(1),
        WeeklyQuota = (int)r.GetInt64(2),
        MinimumHeight = (int)r.GetInt64(3),
        UpdatedAt = r.GetString(4),
    };

    private static List<int> Seasons(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<List<int>>(json, _json) ?? new List<int>();
        }
        catch (JsonException)
        {
            // A hand-edited row must not take the whole listing down.
            return new List<int>();
        }
    }
}
