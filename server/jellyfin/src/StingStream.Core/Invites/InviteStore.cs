using System;
using System.Collections.Generic;
using System.Data;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using StingStream.Core.Data;

namespace StingStream.Core.Invites;

/// <summary>
/// The invites this server has minted.
/// </summary>
/// <remarks>
/// <para>
/// One table in <c>core.db</c>, with the DDL <em>here</em> rather than in
/// <see cref="CoreDatabase.ApplySchema"/>, for the reason <c>RequestStore</c> gives and
/// <c>docs/CONTRIBUTING.md</c> rule 2 states: this file belongs to one work package while
/// <c>CoreDatabase.cs</c> is edited by all of them, and a schema addition is exactly the change
/// that ends up half-committed across two agents. Every statement is <c>IF NOT EXISTS</c> and
/// <see cref="EnsureSchema"/> is idempotent and cheap, so the database ends up identical and
/// <see cref="CoreDatabase.SchemaVersion"/> does not move.
/// </para>
/// <para>
/// <b>Rows, not a settings document.</b> An invite has a lifecycle — minted, then redeemed, then
/// deleted — and two concurrent mints must not lose one of themselves, which is exactly what
/// rewriting a whole document on every change does.
/// </para>
/// </remarks>
public sealed class InviteStore
{
    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private readonly CoreDatabase _db;
    private readonly object _schemaLock = new();
    private bool _schemaReady;

    public InviteStore(CoreDatabase db)
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
                -- One row per invite ever minted, kept after it is spent so an account can be
                -- traced back to the invite that created it.
                --
                -- `token_hash` is a SHA-256 of the token and is what every redemption looks up by.
                -- UNIQUE because a collision would mean two invites answering to one link.
                --
                -- `token` (added below) holds the token itself, and only while the invite is
                -- **live**: it is cleared the moment somebody redeems one. Dan: "allow the user to
                -- re-open the existing invite to get the url again". That is a real trade -- a copy
                -- of this file now yields working links for the invites that have not been used --
                -- and it is bounded on purpose: spent invites keep only their hash, so the file
                -- never accumulates a history of usable credentials, and deleting an invite takes
                -- its token with the row.
                -- `expires_at` is NOT NULL and stays that way: this DDL is IF NOT EXISTS-only by
                -- design, so there is no mechanism here to relax a constraint on a database that
                -- already exists. An invite that does not expire stores InviteGate.NeverExpires,
                -- which InviteGate.IsNever reads back as "never". Rows minted before that keep
                -- their real date and still expire.
                CREATE TABLE IF NOT EXISTS invites (
                    id                 TEXT PRIMARY KEY,
                    token_hash         TEXT NOT NULL UNIQUE,
                    label              TEXT NOT NULL DEFAULT '',
                    libraries          TEXT NOT NULL DEFAULT '[]',
                    created_by         TEXT NOT NULL DEFAULT '',
                    created_by_name    TEXT NOT NULL DEFAULT '',
                    created_at         TEXT NOT NULL,
                    expires_at         TEXT NOT NULL,
                    redeemed_at        TEXT,
                    redeemed_user      TEXT,
                    redeemed_user_name TEXT,
                    revoked_at         TEXT
                );
                CREATE INDEX IF NOT EXISTS ix_invites_created ON invites (created_at);
                """);

            // Additive, nullable, and swallowed when it is already there -- the same shape the mesh
            // database's `migrate()` uses. A separate statement rather than a column in the CREATE
            // above, because that one only ever runs on a database that does not exist yet.
            try
            {
                CoreDatabase.Execute(c, "ALTER TABLE invites ADD COLUMN token TEXT;");
            }
            catch (Microsoft.Data.Sqlite.SqliteException e)
                when (e.Message.Contains("duplicate column name", StringComparison.OrdinalIgnoreCase))
            {
                // Already migrated.
            }

            // Which of the two kinds of person this invite is for. `DEFAULT 0` is doing real work:
            // every invite minted before this column existed created a viewer, and that is exactly
            // what it must go on doing. An invite is never silently promoted by an upgrade.
            try
            {
                CoreDatabase.Execute(
                    c,
                    "ALTER TABLE invites ADD COLUMN is_administrator INTEGER NOT NULL DEFAULT 0;");
            }
            catch (Microsoft.Data.Sqlite.SqliteException e)
                when (e.Message.Contains("duplicate column name", StringComparison.OrdinalIgnoreCase))
            {
                // Already migrated.
            }

            _schemaReady = true;
        }
    }

    private const string Select =
        "SELECT id, token_hash, label, libraries, created_by, created_by_name, created_at, "
        + "expires_at, redeemed_at, redeemed_user, redeemed_user_name, revoked_at, token, "
        + "is_administrator FROM invites";

    /// <summary>Every invite, newest first.</summary>
    /// <returns>The rows.</returns>
    public IReadOnlyList<InviteRow> All()
    {
        EnsureSchema();
        return _db.Read(c => CoreDatabase.Query(c, Select + " ORDER BY created_at DESC;", Map));
    }

    /// <summary>One invite by id.</summary>
    /// <param name="id">The invite id.</param>
    /// <returns>The row, or null.</returns>
    public InviteRow? Get(string id)
    {
        EnsureSchema();
        var rows = _db.Read(c => CoreDatabase.Query(c, Select + " WHERE id = $i;", Map, ("$i", id)));
        return rows.Count > 0 ? rows[0] : null;
    }

    /// <summary>The invite a token names, or null.</summary>
    /// <param name="tokenHash">Lowercase hex SHA-256 of the token.</param>
    /// <returns>The row, or null.</returns>
    /// <remarks>
    /// <para>
    /// Looked up by the hash rather than by scanning and comparing, because the hash is what the
    /// unique index is on and a table scan per redemption attempt is a way to be hurt by traffic.
    /// The caller still runs <c>InviteService.HashMatches</c> over the row it gets back, which
    /// costs nothing and means the constant-time comparison is on the path even if this ever
    /// becomes a prefix match.
    /// </para>
    /// <para>
    /// The equality is on a SHA-256 of a 256-bit random token, so what a timing difference here
    /// could leak is the hash — and a hash is not a credential: presenting one does not redeem
    /// anything, and inverting it to the token it came from is the thing SHA-256 exists to prevent.
    /// </para>
    /// </remarks>
    public InviteRow? ByTokenHash(string tokenHash)
    {
        EnsureSchema();
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE token_hash = $h;",
            Map,
            ("$h", tokenHash)));
        return rows.Count > 0 ? rows[0] : null;
    }

    /// <summary>Insert or replace an invite.</summary>
    /// <param name="row">The row.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task SaveAsync(InviteRow row, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);
        EnsureSchema();
        await _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO invites
                    (id, token_hash, label, libraries, created_by, created_by_name, created_at,
                     expires_at, redeemed_at, redeemed_user, redeemed_user_name, revoked_at, token,
                     is_administrator)
                VALUES ($id, $h, $l, $lib, $cb, $cbn, $ca, $ea, $ra, $ru, $run, $va, $tok, $adm)
                ON CONFLICT(id) DO UPDATE SET
                    token_hash = excluded.token_hash, label = excluded.label,
                    libraries = excluded.libraries, created_by = excluded.created_by,
                    created_by_name = excluded.created_by_name,
                    created_at = excluded.created_at, expires_at = excluded.expires_at,
                    redeemed_at = excluded.redeemed_at, redeemed_user = excluded.redeemed_user,
                    redeemed_user_name = excluded.redeemed_user_name,
                    revoked_at = excluded.revoked_at, token = excluded.token,
                    is_administrator = excluded.is_administrator;
                """,
                ("$id", row.Id),
                ("$h", row.TokenHash),
                ("$l", row.Label),
                ("$lib", JsonSerializer.Serialize(row.Libraries.Select(g => g.ToString("N")), _json)),
                ("$cb", row.CreatedBy),
                ("$cbn", row.CreatedByName),
                ("$ca", Stamp(row.CreatedAt)),
                ("$ea", Stamp(row.ExpiresAt)),
                ("$ra", row.RedeemedAt is { } r ? Stamp(r) : null),
                ("$ru", row.RedeemedUserId),
                ("$run", row.RedeemedUserName),
                ("$va", row.RevokedAt is { } v ? Stamp(v) : null),
                ("$tok", row.Token),
                ("$adm", row.IsAdministrator)),
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Mark an invite spent, but only if it still is not.
    /// </summary>
    /// <param name="id">The invite id.</param>
    /// <param name="userId">The account it created.</param>
    /// <param name="userName">The name that account chose.</param>
    /// <param name="at">When.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when this call is the one that spent it.</returns>
    /// <remarks>
    /// <para>
    /// <b>This is what makes "single use" true rather than nearly true.</b> Reading the row,
    /// deciding it is unredeemed and then writing is a race with a window the width of a user
    /// creation, and a link forwarded to a group chat is exactly the thing that gets opened twice
    /// in the same second. The <c>WHERE redeemed_at IS NULL</c> pushes the decision into SQLite,
    /// which serialises writes, so of two simultaneous redemptions exactly one sees a row affected.
    /// </para>
    /// <para>
    /// It follows that the caller must claim the invite <em>before</em> creating the account, and
    /// give up if this returns false. The alternative ordering leaves the loser of the race holding
    /// a real account nobody meant to create.
    /// </para>
    /// </remarks>
    public async Task<bool> TryRedeemAsync(
        string id,
        string userId,
        string userName,
        DateTimeOffset at,
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        var affected = 0;
        await _db.WriteAsync(
            c => affected = CoreDatabase.Execute(
                c,
                """
                UPDATE invites
                   SET redeemed_at = $ra, redeemed_user = $ru, redeemed_user_name = $run
                 WHERE id = $id AND redeemed_at IS NULL AND revoked_at IS NULL;
                """,
                ("$ra", Stamp(at)),
                ("$ru", userId),
                ("$run", userName),
                ("$id", id)),
            cancellationToken).ConfigureAwait(false);
        return affected > 0;
    }

    /// <summary>
    /// Record which account a claimed invite created, once it exists.
    /// </summary>
    /// <param name="id">The invite id.</param>
    /// <param name="userId">The account it created.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    /// <remarks>
    /// One column, deliberately, rather than saving the row the redemption started from. That row
    /// was read before the account existed, so writing it back whole would carry a stale
    /// <c>revoked_at</c> with it — and an administrator who withdrew the invite in the seconds the
    /// account took to create would find their revocation quietly undone. Nobody could redeem it
    /// twice either way, but the list would say "used" where they had said "withdrawn", and a
    /// security control that silently reverts is not one.
    /// </remarks>
    public async Task SetRedeemedUserAsync(
        string id,
        string userId,
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        await _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                // The token goes here rather than in `TryRedeemAsync`: that claim is tentative
                // and `ReleaseAsync` puts it back, which has to put back a *usable* invite. By
                // this line the account exists and the link is spent for good.
                "UPDATE invites SET redeemed_user = $u, token = NULL WHERE id = $id;",
                ("$u", userId),
                ("$id", id)),
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Give a claimed invite back, because the account it was claimed for was not created.</summary>
    /// <param name="id">The invite id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    /// <remarks>
    /// The other half of claiming first. If creating the account fails — a name the server will not
    /// take, a password it rejects, a disk that is full — the invite has been spent on nothing, and
    /// the person is looking at an error with a link that no longer works. This puts it back.
    /// </remarks>
    public async Task ReleaseAsync(string id, CancellationToken cancellationToken)
    {
        EnsureSchema();
        await _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                "UPDATE invites SET redeemed_at = NULL, redeemed_user = NULL, "
                + "redeemed_user_name = NULL WHERE id = $id;",
                ("$id", id)),
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Delete an invite.</summary>
    /// <param name="id">The invite id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when there was a row to delete.</returns>
    /// <remarks>
    /// <para>
    /// <b>The row goes.</b> This used to be a soft <c>UPDATE ... SET revoked_at</c>, on the
    /// reasoning that the list was the record of what had been shared with whom. Dan: <em>"When
    /// deleteing an invite dont say withdrawn - just delete it."</em> — and the reasoning went with
    /// the same message: <em>"sharing is basically just users not groups at this point."</em> The
    /// record of who has access is the account list, which is where the Sharing screen now reads
    /// People from, so a spent invite is no longer the only trace of anything.
    /// </para>
    /// <para>
    /// <b>An account the invite already created is untouched.</b> Deleting the invite deletes the
    /// invite. Removing somebody's access is a decision about a person, made on the Users screen,
    /// and quietly bundling the two would make a tidy-up into a lockout.
    /// </para>
    /// <para>
    /// <c>revoked_at</c> stays in the schema and <see cref="InviteStatus.Revoked"/> stays in the
    /// gate, because rows written before this still carry one and must keep being refused.
    /// </para>
    /// </remarks>
    public async Task<bool> DeleteAsync(string id, CancellationToken cancellationToken)
    {
        EnsureSchema();
        var affected = 0;
        await _db.WriteAsync(
            c => affected = CoreDatabase.Execute(
                c,
                "DELETE FROM invites WHERE id = $id;",
                ("$id", id)),
            cancellationToken).ConfigureAwait(false);
        return affected > 0;
    }

    private static string Stamp(DateTimeOffset at)
        => at.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

    private static DateTimeOffset ReadStamp(string value)
        => DateTimeOffset.TryParse(
            value,
            CultureInfo.InvariantCulture,
            DateTimeStyles.RoundtripKind,
            out var parsed)
            ? parsed
            // An unparsable timestamp is corruption, and the safe reading of a corrupt expiry is
            // "expired": DateTimeOffset.MinValue is in the past, so the gate refuses.
            : DateTimeOffset.MinValue;

    private static InviteRow Map(IDataRecord r) => new()
    {
        Id = r.GetString(0),
        TokenHash = r.GetString(1),
        Label = r.GetString(2),
        Libraries = ReadLibraries(r.GetString(3)),
        CreatedBy = r.GetString(4),
        CreatedByName = r.GetString(5),
        CreatedAt = ReadStamp(r.GetString(6)),
        ExpiresAt = ReadStamp(r.GetString(7)),
        RedeemedAt = r.IsDBNull(8) ? null : ReadStamp(r.GetString(8)),
        RedeemedUserId = r.IsDBNull(9) ? null : r.GetString(9),
        RedeemedUserName = r.IsDBNull(10) ? null : r.GetString(10),
        RevokedAt = r.IsDBNull(11) ? null : ReadStamp(r.GetString(11)),
        Token = r.IsDBNull(12) ? null : r.GetString(12),
        IsAdministrator = !r.IsDBNull(13) && r.GetInt32(13) != 0,
    };

    private static IReadOnlyList<Guid> ReadLibraries(string json)
    {
        try
        {
            var ids = JsonSerializer.Deserialize<List<string>>(json, _json) ?? new List<string>();
            return ids
                .Select(s => Guid.TryParse(s, out var g) ? g : Guid.Empty)
                .Where(g => !g.Equals(Guid.Empty))
                .ToArray();
        }
        catch (JsonException)
        {
            // A row whose library list cannot be read grants nothing. The other direction --
            // treating unreadable as "everything" -- is how a corrupt row becomes a full-library
            // account.
            return Array.Empty<Guid>();
        }
    }
}
