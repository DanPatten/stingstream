using System;
using System.Collections.Generic;
using System.Data;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using StingStream.Core.Data;

namespace StingStream.Core.Sharing;

/// <summary>An invite link a member brought to this server for an administrator to approve.</summary>
public sealed class ConnectionRequest
{
    /// <summary>Opaque id, safe to show and put in a URL. Never the code.</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>The mesh code from the invite link. A credential; never returned by the API.</summary>
    public string Code { get; set; } = string.Empty;

    /// <summary>Node id of the server that made the invite, as the link said.</summary>
    public string Node { get; set; } = string.Empty;

    /// <summary>What that server calls itself, as the link said.</summary>
    public string ServerName { get; set; } = string.Empty;

    /// <summary>The account here that brought it.</summary>
    public string RequestedBy { get; set; } = string.Empty;

    /// <summary>When it was brought.</summary>
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// Invite links waiting for an administrator here.
/// </summary>
/// <remarks>
/// <para>
/// Dan: <em>"If the user doing it ISNT an admin on that server - thats fine - ... we have everything
/// we need to link until the admin can approve it."</em> A row is exactly that: a working invite from
/// the other server, which already chose what it shares, held until somebody here who may decide
/// presses Approve.
/// </para>
/// <para>
/// One row per other server: bringing a second link from the same one replaces the first. A row
/// lives as long as the invite in it does, seven days, and is removed on approval.
/// </para>
/// <para>
/// DDL here rather than in <see cref="CoreDatabase"/>'s schema, every statement <c>IF NOT EXISTS</c>,
/// for the reason <see cref="SharedLibraryStore"/> gives.
/// </para>
/// </remarks>
public sealed class ConnectionRequestStore
{
    /// <summary>How long a request is kept: as long as the invite inside it works.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromDays(7);

    private const string Select =
        "SELECT id, code, node, server_name, requested_by, created_at FROM connection_requests";

    private readonly CoreDatabase _db;
    private readonly object _schemaLock = new();
    private bool _schemaReady;

    public ConnectionRequestStore(CoreDatabase db)
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
                CREATE TABLE IF NOT EXISTS connection_requests (
                    id           TEXT PRIMARY KEY,
                    code         TEXT NOT NULL,
                    node         TEXT NOT NULL DEFAULT '',
                    server_name  TEXT NOT NULL DEFAULT '',
                    requested_by TEXT NOT NULL DEFAULT '',
                    created_at   TEXT NOT NULL
                );
                """);
            _schemaReady = true;
        }
    }

    /// <summary>Every request still young enough to use, newest first.</summary>
    /// <param name="now">The current time.</param>
    /// <returns>The rows.</returns>
    public IReadOnlyList<ConnectionRequest> All(DateTimeOffset now)
    {
        EnsureSchema();
        return _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE created_at >= $cutoff ORDER BY created_at DESC;",
            Map,
            ("$cutoff", Stamp(now - Lifetime))));
    }

    /// <summary>One request, or null.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="now">The current time.</param>
    /// <returns>The row, or null when there is none or it is too old to use.</returns>
    public ConnectionRequest? Find(string id, DateTimeOffset now)
    {
        EnsureSchema();
        var rows = _db.Read(c => CoreDatabase.Query(
            c,
            Select + " WHERE id = $id AND created_at >= $cutoff;",
            Map,
            ("$id", (id ?? string.Empty).Trim()),
            ("$cutoff", Stamp(now - Lifetime))));
        return rows.Count > 0 ? rows[0] : null;
    }

    /// <summary>Record a request, replacing any earlier one from the same server.</summary>
    /// <param name="row">The request.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task SaveAsync(ConnectionRequest row, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);
        EnsureSchema();
        await _db.WriteAsync(
            c =>
            {
                if (!string.IsNullOrWhiteSpace(row.Node))
                {
                    CoreDatabase.Execute(
                        c,
                        "DELETE FROM connection_requests WHERE lower(node) = $n;",
                        ("$n", row.Node.Trim().ToLowerInvariant()));
                }

                CoreDatabase.Execute(
                    c,
                    """
                    INSERT INTO connection_requests (id, code, node, server_name, requested_by, created_at)
                    VALUES ($id, $code, $n, $sn, $by, $ca);
                    """,
                    ("$id", row.Id),
                    ("$code", row.Code),
                    ("$n", row.Node.Trim().ToLowerInvariant()),
                    ("$sn", row.ServerName),
                    ("$by", row.RequestedBy),
                    ("$ca", Stamp(row.CreatedAt)));
            },
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Remove a request.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when a row went.</returns>
    public async Task<bool> DeleteAsync(string id, CancellationToken cancellationToken)
    {
        EnsureSchema();
        var removed = 0;
        await _db.WriteAsync(
            c => removed = CoreDatabase.Execute(
                c,
                "DELETE FROM connection_requests WHERE id = $id;",
                ("$id", (id ?? string.Empty).Trim())),
            cancellationToken).ConfigureAwait(false);
        return removed > 0;
    }

    /// <summary>Remove requests whose invite has expired.</summary>
    /// <param name="now">The current time.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public Task PruneAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        EnsureSchema();
        return _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                "DELETE FROM connection_requests WHERE created_at < $cutoff;",
                ("$cutoff", Stamp(now - Lifetime))),
            cancellationToken);
    }

    private static ConnectionRequest Map(IDataRecord r) => new()
    {
        Id = r.GetString(0),
        Code = r.GetString(1),
        Node = r.GetString(2),
        ServerName = r.GetString(3),
        RequestedBy = r.GetString(4),
        CreatedAt = DateTimeOffset.TryParse(
            r.GetString(5),
            CultureInfo.InvariantCulture,
            DateTimeStyles.RoundtripKind,
            out var at)
            ? at
            : DateTimeOffset.MinValue,
    };

    private static string Stamp(DateTimeOffset at)
        => at.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
}
