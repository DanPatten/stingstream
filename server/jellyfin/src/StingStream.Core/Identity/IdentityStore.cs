using System;
using System.Collections.Generic;
using System.Data;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using StingStream.Core.Data;

namespace StingStream.Core.Identity;

/// <summary>
/// Which people on other servers hold an account here.
/// </summary>
/// <remarks>
/// <para>
/// One table in <c>core.db</c>, with its DDL here rather than in
/// <see cref="CoreDatabase.ApplySchema"/> — <c>docs/CONTRIBUTING.md</c> rule 2, the same reason
/// <see cref="Invites.InviteStore"/> gives. Every statement is <c>IF NOT EXISTS</c> and
/// <see cref="CoreDatabase.SchemaVersion"/> does not move.
/// </para>
/// <para>
/// <b>The challenges are not in here.</b> They live in memory
/// (<see cref="IdentityChallenges"/>), for the reason <c>PasskeyCeremonies</c> gives: a challenge
/// lives for the seconds between two requests, and persisting one would mean a nonce outliving a
/// restart for no purpose and a table that has to be swept.
/// </para>
/// </remarks>
public sealed class IdentityStore
{
    private readonly CoreDatabase _db;
    private readonly object _schemaLock = new();
    private bool _schemaReady;

    public IdentityStore(CoreDatabase db)
    {
        _db = db;
    }

    /// <summary>Create the table if it is not there. Idempotent; safe to call on every use.</summary>
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
                -- One row per person, per server they come from.
                --
                -- The primary key is (issuer, remote user id) rather than the local account,
                -- because the question this table answers is "who is signing in" and the answer
                -- has to survive them renaming themselves on their own server. `local_user`
                -- carries a UNIQUE index for the other direction: one local account belongs to at
                -- most one remote identity, so a link can never quietly hand two people the same
                -- account.
                CREATE TABLE IF NOT EXISTS linked_identities (
                    issuer_node      TEXT NOT NULL,
                    remote_user      TEXT NOT NULL,
                    local_user       TEXT NOT NULL,
                    remote_user_name TEXT NOT NULL DEFAULT '',
                    issuer_name      TEXT NOT NULL DEFAULT '',
                    created_at       TEXT NOT NULL,
                    last_seen_at     TEXT,
                    PRIMARY KEY (issuer_node, remote_user)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS ux_linked_identities_local
                    ON linked_identities (local_user);

                -- "I run a server too -- may it join yours?"
                --
                -- One row per asking node, not per asking person: what is being asked for is a
                -- link between two *servers*, and two people on the same server asking twice is
                -- one question. The primary key says so.
                --
                -- `code` holds the mesh invite an administrator minted on approval. It is a
                -- credential, and it is single-use and cleared when the row is deleted -- the same
                -- bounded trade `invites.token` makes, and for the same reason: the person it is
                -- for has to be able to come back and find it.
                CREATE TABLE IF NOT EXISTS link_requests (
                    issuer_node   TEXT PRIMARY KEY,
                    issuer_name   TEXT NOT NULL DEFAULT '',
                    requested_by  TEXT NOT NULL DEFAULT '',
                    created_at    TEXT NOT NULL,
                    status        TEXT NOT NULL DEFAULT 'pending',
                    decided_at    TEXT,
                    decided_by    TEXT,
                    group_id      TEXT,
                    code          TEXT
                );
                """);

            _schemaReady = true;
        }
    }

    private const string Select =
        "SELECT issuer_node, remote_user, local_user, remote_user_name, issuer_name, created_at, "
        + "last_seen_at FROM linked_identities";

    /// <summary>Every link, newest first.</summary>
    /// <returns>The rows.</returns>
    public IReadOnlyList<LinkedIdentity> All()
    {
        EnsureSchema();
        return _db.Read(c => CoreDatabase.Query(c, Select + " ORDER BY created_at DESC;", Map));
    }

    /// <summary>The link for one identity on one server, or null.</summary>
    /// <param name="issuerNodeId">The other server's node id.</param>
    /// <param name="remoteUserId">Their user id there.</param>
    /// <returns>The row, or null.</returns>
    public LinkedIdentity? Find(string issuerNodeId, string remoteUserId)
    {
        EnsureSchema();
        // Compared lowercase because a node id is hex and one side of this came off the wire.
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE lower(issuer_node) = $i AND remote_user = $u;",
            Map,
            ("$i", (issuerNodeId ?? string.Empty).Trim().ToLowerInvariant()),
            ("$u", (remoteUserId ?? string.Empty).Trim())));
        return rows.Count > 0 ? rows[0] : null;
    }

    /// <summary>The link a local account belongs to, or null when it is an ordinary account.</summary>
    /// <param name="localUserId">The Jellyfin user id.</param>
    /// <returns>The row, or null.</returns>
    public LinkedIdentity? ForLocalUser(string localUserId)
    {
        EnsureSchema();
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE local_user = $l;",
            Map,
            ("$l", (localUserId ?? string.Empty).Trim())));
        return rows.Count > 0 ? rows[0] : null;
    }

    /// <summary>Write a link, creating it or refreshing what it remembers.</summary>
    /// <param name="row">The link.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    /// <remarks>
    /// The names are refreshed on every sign-in and the account is not: somebody renaming
    /// themselves on their own server should show up here under the new name, and must not thereby
    /// acquire a different account.
    /// </remarks>
    public async Task SaveAsync(LinkedIdentity row, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);
        EnsureSchema();
        await _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO linked_identities
                    (issuer_node, remote_user, local_user, remote_user_name, issuer_name,
                     created_at, last_seen_at)
                VALUES ($i, $u, $l, $un, $sn, $ca, $ls)
                ON CONFLICT(issuer_node, remote_user) DO UPDATE SET
                    remote_user_name = excluded.remote_user_name,
                    issuer_name = excluded.issuer_name,
                    last_seen_at = excluded.last_seen_at;
                """,
                ("$i", row.IssuerNodeId.Trim().ToLowerInvariant()),
                ("$u", row.RemoteUserId.Trim()),
                ("$l", row.LocalUserId.Trim()),
                ("$un", row.RemoteUserName),
                ("$sn", row.IssuerName),
                ("$ca", Stamp(row.CreatedAt)),
                ("$ls", row.LastSeenAt is { } seen ? Stamp(seen) : null)),
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Forget a link. The account it pointed at stays.</summary>
    /// <param name="issuerNodeId">The other server's node id.</param>
    /// <param name="remoteUserId">Their user id there.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when a row went.</returns>
    /// <remarks>
    /// Deleting the link takes away the only way in — the account has a password nobody knows — so
    /// this is closer to disabling an account than to tidying a table. It does not delete the
    /// account, deliberately: what somebody watched and where they got to is theirs, and an
    /// administrator who wants it gone can delete it on the Users screen.
    /// </remarks>
    public async Task<bool> DeleteAsync(
        string issuerNodeId,
        string remoteUserId,
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        var removed = 0;
        await _db.WriteAsync(
            c => removed = CoreDatabase.Execute(
                c,
                "DELETE FROM linked_identities WHERE lower(issuer_node) = $i AND remote_user = $u;",
                ("$i", (issuerNodeId ?? string.Empty).Trim().ToLowerInvariant()),
                ("$u", (remoteUserId ?? string.Empty).Trim())),
            cancellationToken).ConfigureAwait(false);
        return removed > 0;
    }

    // --- link requests -------------------------------------------------------------------------

    private const string SelectRequest =
        "SELECT issuer_node, issuer_name, requested_by, created_at, status, decided_at, "
        + "decided_by, group_id, code FROM link_requests";

    /// <summary>Every request, newest first.</summary>
    /// <returns>The rows.</returns>
    public IReadOnlyList<LinkRequest> AllRequests()
    {
        EnsureSchema();
        return _db.Read(c => CoreDatabase.Query(
            c,
            SelectRequest + " ORDER BY created_at DESC;",
            MapRequest));
    }

    /// <summary>One server's request, or null.</summary>
    /// <param name="issuerNodeId">The asking node.</param>
    /// <returns>The row, or null.</returns>
    public LinkRequest? FindRequest(string issuerNodeId)
    {
        EnsureSchema();
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            SelectRequest + " WHERE lower(issuer_node) = $i;",
            MapRequest,
            ("$i", (issuerNodeId ?? string.Empty).Trim().ToLowerInvariant())));
        return rows.Count > 0 ? rows[0] : null;
    }

    /// <summary>Record a request, or refresh what a pending one remembers.</summary>
    /// <param name="row">The request.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    /// <remarks>
    /// <b>A decision is never overwritten by another ask.</b> The <c>WHERE</c> on the upsert means
    /// somebody asking again after being declined does not quietly reset the row to pending — an
    /// administrator who said no has said no, and undoing that is their decision to make, not a
    /// retry's. Asking again while it is still pending is free and changes only the names.
    /// </remarks>
    public async Task SaveRequestAsync(LinkRequest row, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);
        EnsureSchema();
        await _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO link_requests
                    (issuer_node, issuer_name, requested_by, created_at, status, decided_at,
                     decided_by, group_id, code)
                VALUES ($i, $n, $by, $ca, $st, $da, $db, $g, $code)
                ON CONFLICT(issuer_node) DO UPDATE SET
                    issuer_name = excluded.issuer_name,
                    requested_by = excluded.requested_by
                WHERE link_requests.status = 'pending';
                """,
                ("$i", row.IssuerNodeId.Trim().ToLowerInvariant()),
                ("$n", row.IssuerName),
                ("$by", row.RequestedBy),
                ("$ca", Stamp(row.CreatedAt)),
                ("$st", row.Status),
                ("$da", row.DecidedAt is { } d ? Stamp(d) : null),
                ("$db", row.DecidedBy),
                ("$g", row.GroupId),
                ("$code", row.Code)),
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Record an administrator's answer, but only on a request still waiting for one.</summary>
    /// <param name="issuerNodeId">The asking node.</param>
    /// <param name="status">`approved` or `declined`.</param>
    /// <param name="groupId">The group it was approved into, or null.</param>
    /// <param name="code">The invite minted for it, or null.</param>
    /// <param name="decidedBy">Who decided.</param>
    /// <param name="at">When.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when this call is the one that decided it.</returns>
    /// <remarks>
    /// One <c>UPDATE ... WHERE status = 'pending'</c> rather than a read and then a write, so two
    /// administrators pressing Approve at the same moment mint one invite between them and not
    /// two. Same shape, and the same reason, as <c>InviteStore.TryRedeemAsync</c>.
    /// </remarks>
    public async Task<bool> TryDecideRequestAsync(
        string issuerNodeId,
        string status,
        string? groupId,
        string? code,
        string decidedBy,
        DateTimeOffset at,
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        var changed = 0;
        await _db.WriteAsync(
            c => changed = CoreDatabase.Execute(
                c,
                """
                UPDATE link_requests
                   SET status = $st, decided_at = $da, decided_by = $db,
                       group_id = $g, code = $code
                 WHERE lower(issuer_node) = $i AND status = 'pending';
                """,
                ("$st", status),
                ("$da", Stamp(at)),
                ("$db", decidedBy),
                ("$g", groupId),
                ("$code", code),
                ("$i", (issuerNodeId ?? string.Empty).Trim().ToLowerInvariant())),
            cancellationToken).ConfigureAwait(false);
        return changed > 0;
    }

    /// <summary>Forget a request entirely.</summary>
    /// <param name="issuerNodeId">The asking node.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when a row went.</returns>
    public async Task<bool> DeleteRequestAsync(
        string issuerNodeId,
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        var removed = 0;
        await _db.WriteAsync(
            c => removed = CoreDatabase.Execute(
                c,
                "DELETE FROM link_requests WHERE lower(issuer_node) = $i;",
                ("$i", (issuerNodeId ?? string.Empty).Trim().ToLowerInvariant())),
            cancellationToken).ConfigureAwait(false);
        return removed > 0;
    }

    private static LinkRequest MapRequest(IDataRecord r) => new()
    {
        IssuerNodeId = r.GetString(0),
        IssuerName = r.GetString(1),
        RequestedBy = r.GetString(2),
        CreatedAt = ReadStamp(r.GetString(3)),
        Status = r.GetString(4),
        DecidedAt = r.IsDBNull(5) ? null : ReadStamp(r.GetString(5)),
        DecidedBy = r.IsDBNull(6) ? null : r.GetString(6),
        GroupId = r.IsDBNull(7) ? null : r.GetString(7),
        Code = r.IsDBNull(8) ? null : r.GetString(8),
    };

    private static string Stamp(DateTimeOffset at)
        => at.ToString("O", CultureInfo.InvariantCulture);

    private static DateTimeOffset ReadStamp(string raw)
        => DateTimeOffset.TryParse(
            raw,
            CultureInfo.InvariantCulture,
            DateTimeStyles.RoundtripKind,
            out var at)
            ? at
            : DateTimeOffset.MinValue;

    private static LinkedIdentity Map(IDataRecord r) => new()
    {
        IssuerNodeId = r.GetString(0),
        RemoteUserId = r.GetString(1),
        LocalUserId = r.GetString(2),
        RemoteUserName = r.GetString(3),
        IssuerName = r.GetString(4),
        CreatedAt = ReadStamp(r.GetString(5)),
        LastSeenAt = r.IsDBNull(6) ? null : ReadStamp(r.GetString(6)),
    };
}
