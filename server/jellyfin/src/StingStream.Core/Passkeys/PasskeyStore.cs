using System;
using System.Collections.Generic;
using System.Data;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using StingStream.Core.Data;

namespace StingStream.Core.Passkeys;

/// <summary>One passkey, as it is stored.</summary>
public sealed class PasskeyRow
{
    /// <summary>The credential id, base64url — what the authenticator answers with.</summary>
    public string CredentialId { get; set; } = string.Empty;

    /// <summary>The Jellyfin user it signs in.</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>The domain it was registered against.</summary>
    /// <remarks>
    /// Stored, and matched on every use. A passkey is bound to a relying-party id by the
    /// authenticator, so one registered at <c>media.example.com</c> is simply not offered after the
    /// server moves to another domain — the browser would refuse it anyway, and offering it means a
    /// sign-in screen that fails with no explanation. Keeping the id here is what lets the server
    /// say "these were made for your old address" instead.
    /// </remarks>
    public string RelyingParty { get; set; } = string.Empty;

    /// <summary>The COSE public key.</summary>
    public byte[] PublicKey { get; set; } = Array.Empty<byte>();

    /// <summary>The authenticator's signature counter, as of its last use.</summary>
    /// <remarks>
    /// The clone detector, and the reason this is a column rather than a detail. An authenticator
    /// increments it on every assertion; a counter that goes backwards or stands still means two
    /// devices are answering for one credential. It only works if the value handed to the verifier
    /// is the one from the *last* assertion, which is why <see cref="UpdateCounterAsync"/> exists
    /// and why nothing else may write this row after a sign-in.
    /// </remarks>
    public uint SignCount { get; set; }

    /// <summary>What the authenticator said it is: `usb`, `internal`, `hybrid`… JSON array.</summary>
    public string Transports { get; set; } = "[]";

    /// <summary>Whether the credential may be backed up, and whether it is.</summary>
    public bool BackupEligible { get; set; }

    /// <summary>Whether it currently is.</summary>
    public bool BackedUp { get; set; }

    /// <summary>The authenticator model, when it gave one.</summary>
    public string Aaguid { get; set; } = string.Empty;

    /// <summary>What the person called it. Their own note.</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>When it was registered.</summary>
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>When it last signed somebody in, or null.</summary>
    public DateTimeOffset? LastUsedAt { get; set; }
}

/// <summary>
/// The passkeys registered on this server.
/// </summary>
/// <remarks>
/// One table in <c>core.db</c>, with the DDL here rather than in
/// <see cref="CoreDatabase.ApplySchema"/> — the same reason <c>RequestStore</c> and
/// <c>InviteStore</c> give, and <c>docs/CONTRIBUTING.md</c> rule 2. Every statement is
/// <c>IF NOT EXISTS</c>, so <see cref="CoreDatabase.SchemaVersion"/> does not move.
/// </remarks>
public sealed class PasskeyStore
{
    private readonly CoreDatabase _db;
    private readonly object _schemaLock = new();
    private bool _schemaReady;

    public PasskeyStore(CoreDatabase db)
    {
        _db = db;
    }

    /// <summary>Create the table if it is not there. Idempotent.</summary>
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
                -- One row per registered credential. Nothing secret is in here: a public key is
                -- public, and it is useless without the private half that never leaves the
                -- authenticator. What it does hold is a claim about who may sign in as whom, which
                -- is why `user_id` is never taken from the request.
                CREATE TABLE IF NOT EXISTS passkeys (
                    credential_id   TEXT PRIMARY KEY,
                    user_id         TEXT NOT NULL,
                    relying_party   TEXT NOT NULL,
                    public_key      BLOB NOT NULL,
                    sign_count      INTEGER NOT NULL DEFAULT 0,
                    transports      TEXT NOT NULL DEFAULT '[]',
                    backup_eligible INTEGER NOT NULL DEFAULT 0,
                    backed_up       INTEGER NOT NULL DEFAULT 0,
                    aaguid          TEXT NOT NULL DEFAULT '',
                    label           TEXT NOT NULL DEFAULT '',
                    created_at      TEXT NOT NULL,
                    last_used_at    TEXT
                );
                CREATE INDEX IF NOT EXISTS ix_passkeys_user ON passkeys (user_id);
                CREATE INDEX IF NOT EXISTS ix_passkeys_rp ON passkeys (relying_party);
                """);
            _schemaReady = true;
        }
    }

    private const string Select =
        "SELECT credential_id, user_id, relying_party, public_key, sign_count, transports, "
        + "backup_eligible, backed_up, aaguid, label, created_at, last_used_at FROM passkeys";

    /// <summary>Every passkey one account holds, newest first.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <returns>The rows.</returns>
    public IReadOnlyList<PasskeyRow> ForUser(string userId)
    {
        EnsureSchema();
        return _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE user_id = $u ORDER BY created_at DESC;",
            Map,
            ("$u", userId)));
    }

    /// <summary>Every passkey registered against one domain.</summary>
    /// <param name="relyingParty">The relying-party id.</param>
    /// <returns>The rows.</returns>
    public IReadOnlyList<PasskeyRow> ForRelyingParty(string relyingParty)
    {
        EnsureSchema();
        return _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE relying_party = $r ORDER BY created_at DESC;",
            Map,
            ("$r", relyingParty)));
    }

    /// <summary>One passkey by credential id.</summary>
    /// <param name="credentialId">Base64url credential id.</param>
    /// <returns>The row, or null.</returns>
    public PasskeyRow? ByCredentialId(string credentialId)
    {
        EnsureSchema();
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE credential_id = $c;",
            Map,
            ("$c", credentialId)));
        return rows.Count > 0 ? rows[0] : null;
    }

    /// <summary>Whether a credential id is already registered, to anybody.</summary>
    /// <param name="credentialId">Base64url credential id.</param>
    /// <returns>True when it is.</returns>
    public bool Exists(string credentialId) => ByCredentialId(credentialId) is not null;

    /// <summary>Store a newly registered passkey.</summary>
    /// <param name="row">The row.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task SaveAsync(PasskeyRow row, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);
        EnsureSchema();
        await _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO passkeys
                    (credential_id, user_id, relying_party, public_key, sign_count, transports,
                     backup_eligible, backed_up, aaguid, label, created_at, last_used_at)
                VALUES ($c, $u, $r, $k, $s, $t, $be, $bu, $a, $l, $ca, $lu)
                ON CONFLICT(credential_id) DO UPDATE SET
                    user_id = excluded.user_id, relying_party = excluded.relying_party,
                    public_key = excluded.public_key, sign_count = excluded.sign_count,
                    transports = excluded.transports,
                    backup_eligible = excluded.backup_eligible,
                    backed_up = excluded.backed_up, aaguid = excluded.aaguid,
                    label = excluded.label;
                """,
                ("$c", row.CredentialId),
                ("$u", row.UserId),
                ("$r", row.RelyingParty),
                ("$k", row.PublicKey),
                ("$s", (long)row.SignCount),
                ("$t", row.Transports),
                ("$be", row.BackupEligible ? 1 : 0),
                ("$bu", row.BackedUp ? 1 : 0),
                ("$a", row.Aaguid),
                ("$l", row.Label),
                ("$ca", Stamp(row.CreatedAt)),
                ("$lu", row.LastUsedAt is { } used ? Stamp(used) : null)),
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Write back the counter an assertion produced, and stamp the credential as used.
    /// </summary>
    /// <param name="credentialId">Base64url credential id.</param>
    /// <param name="signCount">The counter the authenticator just reported.</param>
    /// <param name="backedUp">Whether it says it is backed up now.</param>
    /// <param name="at">When.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    /// <remarks>
    /// <para>
    /// <b>This is the bug the Rust version shipped, and it is worth naming.</b> There, the counter
    /// was written to a column that nothing ever read back: the verifier was handed the credential
    /// as it had been stored at registration, so its idea of the counter was frozen at whatever the
    /// authenticator said the day it was made. A cloned authenticator replaying an old assertion
    /// would sail past, because the check is "is this counter greater than the last one" and the
    /// last one never moved. Clone detection is the *only* thing the counter is for, so a counter
    /// that is stored and not read is not a partial feature — it is the appearance of one.
    /// </para>
    /// <para>
    /// So: <see cref="PasskeyService"/> loads the row, hands
    /// <see cref="PasskeyRow.SignCount"/> to the verifier, and calls this with what comes back.
    /// One column, deliberately — a full-row save here would carry a <c>label</c> read before the
    /// user renamed it in another tab.
    /// </para>
    /// </remarks>
    public async Task UpdateCounterAsync(
        string credentialId,
        uint signCount,
        bool backedUp,
        DateTimeOffset at,
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        await _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                "UPDATE passkeys SET sign_count = $s, backed_up = $b, last_used_at = $t "
                + "WHERE credential_id = $c;",
                ("$s", (long)signCount),
                ("$b", backedUp ? 1 : 0),
                ("$t", Stamp(at)),
                ("$c", credentialId)),
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Rename a passkey, if it belongs to this account.</summary>
    /// <param name="credentialId">Base64url credential id.</param>
    /// <param name="userId">The account that must own it.</param>
    /// <param name="label">The new name.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when a row changed.</returns>
    public async Task<bool> RenameAsync(
        string credentialId,
        string userId,
        string label,
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        var affected = 0;
        await _db.WriteAsync(
            c => affected = CoreDatabase.Execute(
                c,
                "UPDATE passkeys SET label = $l WHERE credential_id = $c AND user_id = $u;",
                ("$l", label),
                ("$c", credentialId),
                ("$u", userId)),
            cancellationToken).ConfigureAwait(false);
        return affected > 0;
    }

    /// <summary>
    /// Remove a passkey, if it belongs to this account.
    /// </summary>
    /// <param name="credentialId">Base64url credential id.</param>
    /// <param name="userId">The account that must own it.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when a row was removed.</returns>
    /// <remarks>
    /// The ownership check is in the <c>WHERE</c> rather than in a read before it, so there is no
    /// window in which a credential id belonging to somebody else can be deleted by guessing —
    /// and no path where the check is accidentally skipped by a caller that forgot it.
    /// </remarks>
    public async Task<bool> DeleteAsync(
        string credentialId,
        string userId,
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        var affected = 0;
        await _db.WriteAsync(
            c => affected = CoreDatabase.Execute(
                c,
                "DELETE FROM passkeys WHERE credential_id = $c AND user_id = $u;",
                ("$c", credentialId),
                ("$u", userId)),
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
            : DateTimeOffset.MinValue;

    private static PasskeyRow Map(IDataRecord r) => new()
    {
        CredentialId = r.GetString(0),
        UserId = r.GetString(1),
        RelyingParty = r.GetString(2),
        PublicKey = (byte[])r.GetValue(3),
        // Stored as INTEGER because SQLite has no unsigned type; a counter past int.MaxValue is
        // not something an authenticator produces, but reading it as long and narrowing is what
        // keeps a corrupt row from throwing on the sign-in path.
        SignCount = r.GetInt64(4) is var count && count is > 0 and <= uint.MaxValue
            ? (uint)count
            : 0u,
        Transports = r.GetString(5),
        BackupEligible = r.GetInt64(6) != 0,
        BackedUp = r.GetInt64(7) != 0,
        Aaguid = r.GetString(8),
        Label = r.GetString(9),
        CreatedAt = ReadStamp(r.GetString(10)),
        LastUsedAt = r.IsDBNull(11) ? null : ReadStamp(r.GetString(11)),
    };
}
