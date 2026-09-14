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

                -- The old approve-then-finish link requests. Replaced by connection_requests
                -- (Sharing/ConnectionRequestStore), and dropped because an approved row kept a
                -- dead code forever and left a "Finish linking your server" panel nobody could clear.
                DROP TABLE IF EXISTS link_requests;
                """);

            // Additive, nullable, swallowed when already there -- the same shape and the same
            // reason as `invites.token`: the CREATE above only ever runs on a database that does
            // not exist yet, and this one is a day old on somebody's disk already.
            //
            // Null means "signs in with an ordinary password", which is what every row written
            // before this did and what an administrator's reset puts a row back to. The safe
            // reading is the one an upgrade produces by doing nothing.
            foreach (var column in new[]
                     {
                         "ALTER TABLE linked_identities ADD COLUMN password_salt TEXT;",
                         "ALTER TABLE linked_identities ADD COLUMN password_iterations INTEGER;",
                     })
            {
                try
                {
                    CoreDatabase.Execute(c, column);
                }
                catch (Microsoft.Data.Sqlite.SqliteException e)
                    when (e.Message.Contains("duplicate column name", StringComparison.OrdinalIgnoreCase))
                {
                    // Already migrated.
                }
            }

            _schemaReady = true;
        }
    }

    private const string Select =
        "SELECT issuer_node, remote_user, local_user, remote_user_name, issuer_name, created_at, "
        + "last_seen_at, password_salt, password_iterations FROM linked_identities";

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
                     created_at, last_seen_at, password_salt, password_iterations)
                VALUES ($i, $u, $l, $un, $sn, $ca, $ls, $ps, $pi)
                ON CONFLICT(issuer_node, remote_user) DO UPDATE SET
                    remote_user_name = excluded.remote_user_name,
                    issuer_name = excluded.issuer_name,
                    last_seen_at = excluded.last_seen_at,
                    password_salt = excluded.password_salt,
                    password_iterations = excluded.password_iterations;
                """,
                ("$i", row.IssuerNodeId.Trim().ToLowerInvariant()),
                ("$u", row.RemoteUserId.Trim()),
                ("$l", row.LocalUserId.Trim()),
                ("$un", row.RemoteUserName),
                ("$sn", row.IssuerName),
                ("$ca", Stamp(row.CreatedAt)),
                ("$ls", row.LastSeenAt is { } seen ? Stamp(seen) : null),
                // Written from the row rather than left alone, so a caller that means to clear the
                // derivation can. Every caller that does not mean to has read the row first, so
                // what goes back is what was already there.
                ("$ps", string.IsNullOrWhiteSpace(row.PasswordSalt) ? null : row.PasswordSalt),
                ("$pi", row.PasswordIterations > 0 ? row.PasswordIterations.ToString(CultureInfo.InvariantCulture) : null)),
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
        PasswordSalt = r.IsDBNull(7) ? string.Empty : r.GetString(7),
        PasswordIterations = r.IsDBNull(8) ? 0 : r.GetInt32(8),
    };
}
