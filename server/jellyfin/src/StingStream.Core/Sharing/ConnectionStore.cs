using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using StingStream.Core.Data;

namespace StingStream.Core.Sharing;

/// <summary>What this server remembers about one connection, beyond what the mesh knows.</summary>
public sealed class ConnectionRecord
{
    /// <summary>The group the connection is.</summary>
    public string Group { get; set; } = string.Empty;

    /// <summary>
    /// Where the other server is reached, origin only. From the invite link at connect time, or typed
    /// by an administrator when that server moves. Null when neither has said.
    /// </summary>
    public string? Address { get; set; }

    /// <summary>The account here that made or used the invite. Empty for a connection made before this.</summary>
    public string ConnectedBy { get; set; } = string.Empty;
}

/// <summary>
/// The other server's address and who connected it, per connection.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why an address is kept here at all.</b> The mesh learns where a peer is from that peer's own
/// heartbeat, which arrives some seconds after the connection is made, so the Servers page showed
/// "No address available" until a refresh. Dan: <em>"make sure during the connection we remember the
/// domain"</em>. The invite link carries the address of the server that made it, and this is where it
/// lands. Dan again: <em>"allow the user to change the domain in case the server moves"</em>, so an
/// administrator can overwrite it.
/// </para>
/// <para>
/// <b>It wins over what the peer announces.</b> Somebody who typed an address did so because the
/// announced one was wrong or unreachable from here.
/// </para>
/// <para>
/// DDL here, <c>IF NOT EXISTS</c>, schema version untouched: the same reasoning as
/// <see cref="SharedLibraryStore"/>.
/// </para>
/// </remarks>
public sealed class ConnectionStore
{
    private readonly CoreDatabase _database;
    private readonly object _schemaLock = new();
    private bool _schemaReady;

    /// <summary>Initializes a new instance of the <see cref="ConnectionStore"/> class.</summary>
    /// <param name="database">The core database.</param>
    public ConnectionStore(CoreDatabase database)
    {
        _database = database;
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

            using var connection = _database.Open();
            CoreDatabase.Execute(
                connection,
                """
                CREATE TABLE IF NOT EXISTS connections (
                    group_id     TEXT PRIMARY KEY,
                    address      TEXT,
                    connected_by TEXT NOT NULL DEFAULT '',
                    updated_at   TEXT NOT NULL
                );
                """);
            _schemaReady = true;
        }
    }

    /// <summary>
    /// An address as this store keeps it: an absolute http or https origin, or null.
    /// </summary>
    /// <param name="input">What was typed or carried.</param>
    /// <param name="normalized">The origin, or null for empty input.</param>
    /// <returns>False when the input is not empty and is not a usable address.</returns>
    public static bool TryNormalizeAddress(string? input, out string? normalized)
    {
        normalized = null;
        var trimmed = input?.Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return true;
        }

        if (!trimmed.Contains("://", StringComparison.Ordinal))
        {
            trimmed = "https://" + trimmed;
        }

        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || string.IsNullOrEmpty(uri.Host))
        {
            return false;
        }

        normalized = uri.GetLeftPart(UriPartial.Authority);
        return true;
    }

    /// <summary>One connection's record, or null.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The record.</returns>
    public async Task<ConnectionRecord?> GetAsync(string group, CancellationToken cancellationToken)
    {
        EnsureSchema();
        await using var connection = _database.Open();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT address, connected_by FROM connections WHERE group_id = $g;";
        command.Parameters.AddWithValue("$g", group);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new ConnectionRecord
        {
            Group = group,
            Address = await reader.IsDBNullAsync(0, cancellationToken).ConfigureAwait(false)
                ? null
                : reader.GetString(0),
            ConnectedBy = await reader.IsDBNullAsync(1, cancellationToken).ConfigureAwait(false)
                ? string.Empty
                : reader.GetString(1),
        };
    }

    /// <summary>Every saved address, keyed by group id.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Group id to address, only where one is set.</returns>
    public async Task<IReadOnlyDictionary<string, string>> AddressesAsync(CancellationToken cancellationToken)
    {
        EnsureSchema();
        var all = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        await using var connection = _database.Open();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT group_id, address FROM connections WHERE address IS NOT NULL AND address <> '';";
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            all[reader.GetString(0)] = reader.GetString(1);
        }

        return all;
    }

    /// <summary>Record a connection as it is made. A null argument keeps what is already stored.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="address">The other server's address, already normalized, or null.</param>
    /// <param name="connectedBy">The account here, or null.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task SaveAsync(
        string group,
        string? address,
        string? connectedBy,
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        await using var connection = _database.Open();
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO connections (group_id, address, connected_by, updated_at)
            VALUES ($g, $a, COALESCE($b, ''), $u)
            ON CONFLICT(group_id) DO UPDATE SET
                address = COALESCE(excluded.address, connections.address),
                connected_by = CASE WHEN $b IS NULL THEN connections.connected_by ELSE excluded.connected_by END,
                updated_at = excluded.updated_at;
            """;
        command.Parameters.AddWithValue("$g", group);
        command.Parameters.AddWithValue("$a", (object?)address ?? DBNull.Value);
        command.Parameters.AddWithValue("$b", string.IsNullOrEmpty(connectedBy) ? DBNull.Value : connectedBy);
        command.Parameters.AddWithValue("$u", DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Set or clear the address an administrator typed.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="address">The address, already normalized, or null to clear.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task SetAddressAsync(string group, string? address, CancellationToken cancellationToken)
    {
        EnsureSchema();
        await using var connection = _database.Open();
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO connections (group_id, address, connected_by, updated_at)
            VALUES ($g, $a, '', $u)
            ON CONFLICT(group_id) DO UPDATE SET address = excluded.address, updated_at = excluded.updated_at;
            """;
        command.Parameters.AddWithValue("$g", group);
        command.Parameters.AddWithValue("$a", (object?)address ?? DBNull.Value);
        command.Parameters.AddWithValue("$u", DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Forget a connection, when it is gone.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task RemoveAsync(string group, CancellationToken cancellationToken)
    {
        EnsureSchema();
        await using var connection = _database.Open();
        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM connections WHERE group_id = $g;";
        command.Parameters.AddWithValue("$g", group);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }
}
