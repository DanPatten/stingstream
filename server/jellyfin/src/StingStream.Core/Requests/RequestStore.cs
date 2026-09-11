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
                    fulfilling_server_name TEXT,
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

                -- One row per group: whether anybody in it has an indexer configured, and so
                -- whether requests are governed by the approval policy or go onto an
                -- administrator's wanted list to be satisfied by hand.
                --
                -- Written by the request loop, which is the only thing that hears what peers
                -- advertise. Read by RequestService when a request is made, which must answer
                -- synchronously and cannot wait on the mesh -- see CreateAsync's own remarks.
                -- Absent means manual, which is correct for a node whose loop has never run: it is
                -- a fresh install, and a fresh install has no indexers.
                CREATE TABLE IF NOT EXISTS request_group_mode (
                    group_id   TEXT PRIMARY KEY,
                    automatic  INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
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

                -- What an artwork provider said about a title the arrs had no poster for. A null
                -- poster_url is a *known miss* and is the reason this table exists at all: roughly
                -- four in five of these lookups find nothing, and without remembering that, every
                -- search would re-ask for every gap it has already been told about.
                CREATE TABLE IF NOT EXISTS artwork_lookup (
                    provider    TEXT    NOT NULL,
                    provider_id INTEGER NOT NULL,
                    poster_url  TEXT,
                    checked_at  TEXT    NOT NULL,
                    PRIMARY KEY (provider, provider_id)
                );

                -- One provider's id translated into another's, e.g. a TMDB series id to the TVDB
                -- id every series item key is built from. A null target_id is a known miss, for
                -- the same reason artwork_lookup remembers one: the catalogue asks about the same
                -- twenty shows every time somebody opens it, and a show TMDB knows no TVDB id for
                -- will never grow one on the next page load.
                CREATE TABLE IF NOT EXISTS provider_id_map (
                    source     TEXT    NOT NULL,
                    source_id  INTEGER NOT NULL,
                    target     TEXT    NOT NULL,
                    target_id  INTEGER,
                    checked_at TEXT    NOT NULL,
                    PRIMARY KEY (source, source_id, target)
                );
                """);

            // What the request was made from, kept so the app can show it later. Both come off the
            // search result that created the row and are on nothing else: the overview is not
            // stored by either manager in a form this can reach, and nobody asks TVDB how long a
            // show is once the request exists. Without them the edit sheet opened on a poster with
            // no blurb and a fixed twenty season squares for a four-season show.
            //
            // Additive, nullable, and swallowed when already there -- the same shape `InviteStore`
            // uses, and for the same reason: the CREATE above only runs on a database that does not
            // exist yet.
            AddColumn(c, "ALTER TABLE requests ADD COLUMN overview TEXT;");
            AddColumn(c, "ALTER TABLE requests ADD COLUMN season_count INTEGER NOT NULL DEFAULT 0;");

            // Why somebody asked for a title the group already held, and anything they added in
            // their own words. Null for an ordinary request, which is nearly all of them.
            // A server has one name, and the column that holds the fulfiller's says so. Renamed
            // rather than added so no request forgets who filled it.
            RenameColumn(
                c,
                "ALTER TABLE requests RENAME COLUMN fulfilling_node_name TO fulfilling_server_name;");
            AddColumn(c, "ALTER TABLE requests ADD COLUMN reason TEXT;");
            AddColumn(c, "ALTER TABLE requests ADD COLUMN reason_note TEXT;");
            _schemaReady = true;
        }
    }

    /// <summary>Run an additive migration, and say nothing when it has already been run.</summary>
    /// <param name="connection">The open connection.</param>
    /// <param name="sql">An <c>ALTER TABLE ... ADD COLUMN</c>.</param>
    private static void AddColumn(Microsoft.Data.Sqlite.SqliteConnection connection, string sql)
    {
        try
        {
            CoreDatabase.Execute(connection, sql);
        }
        catch (Microsoft.Data.Sqlite.SqliteException e)
            when (e.Message.Contains("duplicate column name", StringComparison.OrdinalIgnoreCase))
        {
            // Already migrated.
        }
    }

    /// <summary>Rename a column, ignoring a database that has already had it done.</summary>
    /// <remarks>
    /// The sibling of <c>AddColumn</c>, and it swallows a different error: a rename that has
    /// already happened reports the *old* name as missing rather than the new one as duplicated.
    /// </remarks>
    private static void RenameColumn(Microsoft.Data.Sqlite.SqliteConnection connection, string sql)
    {
        try
        {
            CoreDatabase.Execute(connection, sql);
        }
        catch (Microsoft.Data.Sqlite.SqliteException e)
            when (e.Message.Contains("no such column", StringComparison.OrdinalIgnoreCase))
        {
            // Already migrated.
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
            // 'wanted' belongs here for the same reason the other three do: a title already on the
            // administrator's list must absorb a second person asking for it, not sit beside a
            // duplicate. It is the state most likely to be asked for twice, because it is the one
            // that waits longest.
            Select + " WHERE item_key = $k AND state IN ('pending','approved','fulfilling','wanted') "
                   + "ORDER BY requested_at DESC;",
            Map,
            ("$k", itemKey)));
        return rows.Count > 0 ? rows[0] : null;
    }

    /// <summary>
    /// The most recent request this node made for a title, in any state.
    /// </summary>
    /// <param name="itemKey">The item key, or the series prefix.</param>
    /// <returns>The row, or null.</returns>
    /// <remarks>
    /// <para>
    /// What <see cref="OpenForItem"/> cannot answer: whether this title has been asked for here
    /// before and <em>finished</em> -- declined, failed, or filled and since gone. Asking again
    /// reopens that row rather than filing a second one beside it, so a list never shows the same
    /// title twice and everything already tried stays attached to the title it was tried on.
    /// </para>
    /// <para>
    /// Restricted to <c>mine = 1</c>, unlike <see cref="LatestForItem"/>. A row heard over gossip
    /// belongs to the node that made it; reopening one would be this node quietly rewriting
    /// somebody else's request, and only the origin may approve, decline or delete one.
    /// </para>
    /// </remarks>
    public RequestRow? LatestMineForItem(string itemKey)
    {
        EnsureSchema();
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE item_key = $k AND mine = 1 ORDER BY requested_at DESC;",
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
                     overview, season_count,
                     seasons, state, requested_by, requested_by_name, requested_at, decided_by,
                     decided_by_name, decided_at, fulfilling_node, fulfilling_server_name, note, mine,
                     updated_at, reason, reason_note)
                VALUES ($id, $g, $k, $ik, $p, $pid, $t, $y, $pu, $ov, $sc, $s, $st, $rb, $rbn, $ra,
                        $db, $dbn, $da, $fn, $fnn, $n, $m, $u, $rsn, $rsnn)
                ON CONFLICT(id) DO UPDATE SET
                    group_id = excluded.group_id, kind = excluded.kind,
                    item_key = excluded.item_key, provider = excluded.provider,
                    provider_id = excluded.provider_id, title = excluded.title,
                    year = excluded.year, poster_url = excluded.poster_url,
                    overview = excluded.overview, season_count = excluded.season_count,
                    seasons = excluded.seasons, state = excluded.state,
                    requested_by = excluded.requested_by,
                    requested_by_name = excluded.requested_by_name,
                    requested_at = excluded.requested_at, decided_by = excluded.decided_by,
                    decided_by_name = excluded.decided_by_name, decided_at = excluded.decided_at,
                    fulfilling_node = excluded.fulfilling_node,
                    fulfilling_server_name = excluded.fulfilling_server_name,
                    note = excluded.note, mine = excluded.mine, updated_at = excluded.updated_at,
                    reason = excluded.reason, reason_note = excluded.reason_note;
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
                ("$ov", row.Overview),
                ("$sc", row.SeasonCount),
                ("$s", JsonSerializer.Serialize(row.Seasons, _json)),
                ("$st", row.State),
                ("$rb", row.RequestedBy),
                ("$rbn", row.RequestedByName),
                ("$ra", row.RequestedAt),
                ("$db", row.DecidedBy),
                ("$dbn", row.DecidedByName),
                ("$da", row.DecidedAt),
                ("$fn", row.FulfillingNode),
                ("$fnn", row.FulfillingServerName),
                ("$n", row.Note),
                ("$m", row.Mine ? 1 : 0),
                ("$u", row.UpdatedAt),
                ("$rsn", row.Reason),
                ("$rsnn", row.ReasonNote)),
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

    /// <summary>
    /// Whether a group fulfils requests automatically, as the request loop last worked it out.
    /// </summary>
    /// <param name="group">The group id, or empty for a standalone node.</param>
    /// <returns>True when somebody in the group has an indexer configured.</returns>
    /// <remarks>
    /// <para>
    /// Read rather than computed, because the answer depends on what peers advertise and
    /// <see cref="RequestService.CreateAsync"/> must decide a request's opening state without
    /// waiting on the mesh. The loop writes it every pass; this reads the last answer.
    /// </para>
    /// <para>
    /// **Absent means manual**, and not by accident. A node whose request loop has never run is a
    /// node that has just been installed, and a fresh install has no indexers. Guessing
    /// "automatic" there would auto-approve the very first request somebody made and then leave it
    /// waiting on a download nothing was ever going to start.
    /// </para>
    /// </remarks>
    public bool IsAutomaticMode(string? group)
    {
        EnsureSchema();
        var key = group ?? string.Empty;
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            "SELECT automatic FROM request_group_mode WHERE group_id = $g;",
            r => r.GetInt64(0) != 0,
            ("$g", key)));
        return rows.Count > 0 && rows[0];
    }

    /// <summary>Whether any group this node belongs to fulfils requests automatically.</summary>
    /// <returns>True when at least one does.</returns>
    /// <remarks>
    /// The coarse question, for telling the app which shape of request UI to draw. It cannot ask
    /// about a particular group because working out which group a request will land in needs the
    /// mesh, and the screen asking this is drawn before anybody has chosen anything. A node in one
    /// group, which is nearly all of them, gets the same answer either way.
    /// </remarks>
    public bool AnyGroupAutomatic()
    {
        EnsureSchema();
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            "SELECT 1 FROM request_group_mode WHERE automatic <> 0 LIMIT 1;",
            r => r.GetInt64(0)));
        return rows.Count > 0;
    }

    /// <summary>Record how a group is fulfilling requests.</summary>
    /// <param name="group">The group id, or empty.</param>
    /// <param name="automatic">Whether anybody in it has an indexer configured.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task SetGroupModeAsync(string? group, bool automatic, CancellationToken cancellationToken)
    {
        EnsureSchema();
        return _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO request_group_mode (group_id, automatic, updated_at)
                VALUES ($g, $a, $u)
                ON CONFLICT(group_id) DO UPDATE SET
                    automatic = excluded.automatic, updated_at = excluded.updated_at;
                """,
                ("$g", group ?? string.Empty),
                ("$a", automatic ? 1 : 0),
                ("$u", Now())),
            cancellationToken);
    }

    /// <summary>
    /// Move a group's unclaimed requests onto the wanted list, for when its last indexer goes.
    /// </summary>
    /// <param name="group">The group id, or empty.</param>
    /// <param name="note">The sentence to leave on each row.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>How many rows moved.</returns>
    /// <remarks>
    /// <para>
    /// Only <c>pending</c> and <c>approved</c>, deliberately. Both are rows nothing has started on,
    /// and leaving them would strand a request waiting for an approval screen that has just
    /// disappeared, or waiting to be routed to a node that can no longer search.
    /// </para>
    /// <para>
    /// <c>fulfilling</c> is left alone. Somebody is already grabbing it, possibly on another node
    /// that still has its own indexers, and it can still legitimately fail through the ordinary
    /// paths. Reaching into a claim in flight to relabel it would be this node overruling the one
    /// doing the work.
    /// </para>
    /// </remarks>
    public async Task<int> ConvertUnclaimedToWantedAsync(
        string? group,
        string note,
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        var moved = 0;
        await _db.WriteAsync(
            c => moved = CoreDatabase.Execute(
                c,
                """
                UPDATE requests
                   SET state = 'wanted', note = $n, updated_at = $u
                 WHERE group_id = $g AND mine = 1 AND state IN ('pending','approved');
                """,
                ("$g", group ?? string.Empty),
                ("$n", note),
                ("$u", Now())),
            cancellationToken).ConfigureAwait(false);
        return moved;
    }

    /// <summary>Requests in any of several states.</summary>
    /// <param name="states">The states.</param>
    /// <returns>The rows.</returns>
    public IReadOnlyList<RequestRow> InStates(params string[] states)
    {
        ArgumentNullException.ThrowIfNull(states);
        EnsureSchema();
        if (states.Length == 0)
        {
            return Array.Empty<RequestRow>();
        }

        // Built rather than parameterised because SQLite has no array binding, and every caller
        // passes constants from RequestStates. Quoted anyway: a literal built by hand is a literal
        // somebody will one day pass a variable to.
        var quoted = new string[states.Length];
        for (var i = 0; i < states.Length; i++)
        {
            quoted[i] = "'" + states[i].Replace("'", "''", StringComparison.Ordinal) + "'";
        }

        var list = string.Join(",", quoted);
        return _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE state IN (" + list + ") ORDER BY requested_at;",
            Map));
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

    // --- artwork lookups ---------------------------------------------------

    /// <summary>How long a found poster is believed before we ask again.</summary>
    private static readonly TimeSpan _artworkHitTtl = TimeSpan.FromDays(30);

    /// <summary>
    /// How long a miss is believed. Shorter than a hit: a show with no artwork today may be given
    /// some next month, and a month of placeholder after that would be our own fault.
    /// </summary>
    private static readonly TimeSpan _artworkMissTtl = TimeSpan.FromDays(7);

    /// <summary>
    /// What a provider last said about a title, if it was recent enough to still believe.
    /// </summary>
    /// <param name="provider">The id space the lookup was keyed on, currently <c>tvdb</c>.</param>
    /// <param name="providerId">The id.</param>
    /// <param name="posterUrl">
    /// The cached poster, or null. Null with a <c>true</c> return is a remembered miss, which is a
    /// different thing from a cache with nothing in it and must not be re-asked.
    /// </param>
    /// <returns>True when there is a fresh answer, whether or not it found a poster.</returns>
    public bool TryCachedArtwork(string provider, int providerId, out string? posterUrl)
    {
        EnsureSchema();
        posterUrl = null;

        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            "SELECT poster_url, checked_at FROM artwork_lookup WHERE provider = $p AND provider_id = $i;",
            r => (Url: r.IsDBNull(0) ? null : r.GetString(0), CheckedAt: r.GetString(1)),
            ("$p", provider),
            ("$i", providerId)));

        if (rows.Count == 0)
        {
            return false;
        }

        var (url, checkedAt) = rows[0];
        if (!DateTime.TryParse(
                checkedAt,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out var when))
        {
            return false;
        }

        var ttl = url is null ? _artworkMissTtl : _artworkHitTtl;
        if (DateTime.UtcNow - when.ToUniversalTime() > ttl)
        {
            return false;
        }

        posterUrl = url;
        return true;
    }

    /// <summary>
    /// Remember what a provider said, including that it said nothing.
    /// </summary>
    /// <param name="provider">The id space, currently <c>tvdb</c>.</param>
    /// <param name="providerId">The id.</param>
    /// <param name="posterUrl">The poster found, or null for a miss.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task CacheArtworkAsync(
        string provider,
        int providerId,
        string? posterUrl,
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        return _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO artwork_lookup (provider, provider_id, poster_url, checked_at)
                VALUES ($p, $i, $u, $a)
                ON CONFLICT(provider, provider_id) DO UPDATE SET
                    poster_url = excluded.poster_url, checked_at = excluded.checked_at;
                """,
                ("$p", provider),
                ("$i", providerId),
                ("$u", posterUrl),
                ("$a", Now())),
            cancellationToken);
    }

    // --- provider id translation -------------------------------------------

    /// <summary>How long a translated id is believed. Provider ids do not move.</summary>
    private static readonly TimeSpan _providerIdHitTtl = TimeSpan.FromDays(90);

    /// <summary>
    /// How long "that provider knows no such id" is believed.
    /// </summary>
    /// <remarks>
    /// Shorter than a hit, and for the same reason as the artwork miss: a show TMDB has no TVDB id
    /// for today may be matched up next month, and a quarter of never asking again would leave it
    /// permanently unrequestable.
    /// </remarks>
    private static readonly TimeSpan _providerIdMissTtl = TimeSpan.FromDays(7);

    /// <summary>The cached translation of one provider's id into another's.</summary>
    /// <param name="source">The provider the id is from, e.g. <c>tmdb</c>.</param>
    /// <param name="sourceId">That provider's id.</param>
    /// <param name="target">The provider wanted, e.g. <c>tvdb</c>.</param>
    /// <param name="targetId">The translated id, or null for a remembered miss.</param>
    /// <returns>True when the answer is cached and still fresh, miss included.</returns>
    public bool TryCachedProviderId(string source, int sourceId, string target, out int? targetId)
    {
        EnsureSchema();
        targetId = null;

        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            "SELECT target_id, checked_at FROM provider_id_map "
            + "WHERE source = $s AND source_id = $i AND target = $t;",
            r => (Id: r.IsDBNull(0) ? (int?)null : r.GetInt32(0), CheckedAt: r.GetString(1)),
            ("$s", source),
            ("$i", sourceId),
            ("$t", target)));

        if (rows.Count == 0)
        {
            return false;
        }

        var (id, checkedAt) = rows[0];
        if (!DateTime.TryParse(
                checkedAt,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out var when))
        {
            return false;
        }

        var ttl = id is null ? _providerIdMissTtl : _providerIdHitTtl;
        if (DateTime.UtcNow - when.ToUniversalTime() > ttl)
        {
            return false;
        }

        targetId = id;
        return true;
    }

    /// <summary>Remember a translation, including a miss.</summary>
    /// <param name="source">The provider the id is from.</param>
    /// <param name="sourceId">That provider's id.</param>
    /// <param name="target">The provider wanted.</param>
    /// <param name="targetId">The translated id, or null when there is none.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task CacheProviderIdAsync(
        string source,
        int sourceId,
        string target,
        int? targetId,
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        return _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO provider_id_map (source, source_id, target, target_id, checked_at)
                VALUES ($s, $i, $t, $x, $a)
                ON CONFLICT(source, source_id, target) DO UPDATE SET
                    target_id = excluded.target_id, checked_at = excluded.checked_at;
                """,
                ("$s", source),
                ("$i", sourceId),
                ("$t", target),
                ("$x", targetId),
                ("$a", Now())),
            cancellationToken);
    }

    // --- mapping -----------------------------------------------------------

    private const string Select =
        "SELECT id, group_id, kind, item_key, provider, provider_id, title, year, poster_url, "
        + "seasons, state, requested_by, requested_by_name, requested_at, decided_by, "
        + "decided_by_name, decided_at, fulfilling_node, fulfilling_server_name, note, mine, "
        + "updated_at, overview, season_count, reason, reason_note FROM requests";

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
        FulfillingServerName = r.IsDBNull(18) ? null : r.GetString(18),
        Note = r.GetString(19),
        Mine = r.GetInt64(20) != 0,
        UpdatedAt = r.GetString(21),
        Overview = r.IsDBNull(22) ? null : r.GetString(22),
        SeasonCount = (int)r.GetInt64(23),
        Reason = r.IsDBNull(24) ? null : r.GetString(24),
        ReasonNote = r.IsDBNull(25) ? null : r.GetString(25),
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
