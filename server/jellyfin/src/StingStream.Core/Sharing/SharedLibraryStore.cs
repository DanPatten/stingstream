using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using StingStream.Core.Data;

namespace StingStream.Core.Sharing;

/// <summary>
/// Which of this server's libraries are shared into each link.
/// </summary>
/// <remarks>
/// <para>
/// Dan, choosing the shape of sharing: <em>"Each side picks its own"</em> — you choose which of
/// your libraries another server owner gets, and they choose which of theirs you get. Nothing is
/// shared until each side says so.
/// </para>
/// <para>
/// Before this, <c>InventoryPublisher</c> built one record set and pushed the same one to every
/// group it belonged to — its own summary said <em>"this node's entire inventory to every
/// group"</em> — so linking with somebody shared everything you had, and a per-library control on
/// the sharing screen would have been decoration.
/// </para>
/// <para>
/// <b>The default is nothing.</b> A link with no row here shares no libraries at all, not every
/// library. A new link that shows an empty library is a question its owner can answer; a new link
/// that silently published their whole collection is not.
/// </para>
/// <para>
/// The DDL lives here rather than in <see cref="CoreDatabase"/>'s schema, and every statement is
/// <c>IF NOT EXISTS</c>, so <see cref="CoreDatabase.SchemaVersion"/> does not move —
/// <c>docs/CONTRIBUTING.md</c> rule 2, the same reasoning as
/// <c>Invites/InviteStore</c> and <c>Requests/RequestStore</c>.
/// </para>
/// </remarks>
public interface ISharedLibraries
{
    /// <summary>What is shared into every link, keyed by group id.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>One entry per link that has ever been configured.</returns>
    Task<IReadOnlyDictionary<string, IReadOnlyList<Guid>>> AllAsync(CancellationToken cancellationToken);
}

/// <inheritdoc cref="ISharedLibraries"/>
public sealed class SharedLibraryStore : ISharedLibraries
{
    private readonly CoreDatabase _database;
    private readonly object _schemaLock = new();
    private bool _schemaReady;

    /// <summary>Initializes a new instance of the <see cref="SharedLibraryStore"/> class.</summary>
    /// <param name="database">The core database.</param>
    public SharedLibraryStore(CoreDatabase database)
    {
        _database = database;
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

            using var connection = _database.Open();
            CoreDatabase.Execute(
                connection,
                """
                -- One row per link: which of this server's libraries are published into it.
                --
                -- No row means share nothing. That is the deliberate default -- see the class
                -- summary -- and it is why this table has no "share everything" sentinel.
                CREATE TABLE IF NOT EXISTS shared_libraries (
                    group_id   TEXT PRIMARY KEY,
                    libraries  TEXT NOT NULL DEFAULT '[]',
                    updated_at TEXT NOT NULL
                );
                """);
            _schemaReady = true;
        }
    }

    /// <summary>What is shared into one link.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The library ids, empty when nothing is shared.</returns>
    public async Task<IReadOnlyList<Guid>> GetAsync(string group, CancellationToken cancellationToken)
    {
        EnsureSchema();
        await using var connection = _database.Open();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT libraries FROM shared_libraries WHERE group_id = $g;";
        command.Parameters.AddWithValue("$g", group);
        var json = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) as string;
        return Parse(json);
    }

    /// <inheritdoc />
    /// <remarks>
    /// Read once per publish pass rather than once per group: the publisher already holds every
    /// group, and a table this small is one query either way.
    /// </remarks>
    public async Task<IReadOnlyDictionary<string, IReadOnlyList<Guid>>> AllAsync(
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        var all = new Dictionary<string, IReadOnlyList<Guid>>(StringComparer.Ordinal);
        await using var connection = _database.Open();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT group_id, libraries FROM shared_libraries;";
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var json = await reader.IsDBNullAsync(1, cancellationToken).ConfigureAwait(false)
                ? null
                : reader.GetString(1);
            all[reader.GetString(0)] = Parse(json);
        }

        return all;
    }

    /// <summary>Replace what is shared into one link.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="libraries">The libraries to share. Empty means share nothing.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    /// <remarks>
    /// A whole-list write, because an absent id is how a library is un-shared: sending only what
    /// changed would make "the owner removed this one" indistinguishable from "the screen did not
    /// mention it".
    /// </remarks>
    public async Task SetAsync(
        string group,
        IReadOnlyList<Guid> libraries,
        CancellationToken cancellationToken)
    {
        EnsureSchema();
        await using var connection = _database.Open();
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO shared_libraries (group_id, libraries, updated_at)
            VALUES ($g, $l, $u)
            ON CONFLICT(group_id) DO UPDATE SET
                libraries = excluded.libraries, updated_at = excluded.updated_at;
            """;
        command.Parameters.AddWithValue("$g", group);
        command.Parameters.AddWithValue(
            "$l",
            JsonSerializer.Serialize(libraries.Select(id => id.ToString("N")).ToArray()));
        command.Parameters.AddWithValue(
            "$u",
            DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Forget a link's choice, when the link itself is gone.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task RemoveAsync(string group, CancellationToken cancellationToken)
    {
        EnsureSchema();
        await using var connection = _database.Open();
        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM shared_libraries WHERE group_id = $g;";
        command.Parameters.AddWithValue("$g", group);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private static IReadOnlyList<Guid> Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return Array.Empty<Guid>();
        }

        try
        {
            var ids = JsonSerializer.Deserialize<string[]>(json) ?? Array.Empty<string>();
            return ids
                .Select(id => Guid.TryParse(id, out var parsed) ? parsed : Guid.Empty)
                .Where(id => !id.Equals(Guid.Empty))
                .ToArray();
        }
        catch (JsonException)
        {
            // A row nobody can read shares nothing, which is the safe direction.
            return Array.Empty<Guid>();
        }
    }
}
