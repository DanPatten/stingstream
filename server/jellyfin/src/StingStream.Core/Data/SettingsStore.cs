using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace StingStream.Core.Data;

/// <summary>
/// Reads and writes the Omniarr shared settings document and the per-app sync status.
/// </summary>
public sealed class SettingsStore : IDisposable
{
    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
    };

    private readonly CoreDatabase _db;
    private readonly ILogger<SettingsStore> _logger;

    /// <summary>Serializes <see cref="UpdateAsync"/>'s read-change-save against itself.</summary>
    private readonly SemaphoreSlim _gate = new(1, 1);

    public SettingsStore(CoreDatabase db, ILogger<SettingsStore> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// The current shared settings, or freshly-created defaults when the node has never been
    /// configured. Never returns <see langword="null"/>: a node with no settings still has to be
    /// able to run its first-run wiring.
    /// </summary>
    /// <returns>The settings, with any pending in-memory migration already applied.</returns>
    /// <remarks>
    /// <see cref="LibraryMigration"/> runs here rather than as a startup step so that every reader
    /// sees the current shape from its very first read, whatever order services happen to start in
    /// and whether or not anything has written to <c>core.db</c> yet. It is a pure in-memory
    /// transform; persisting it is <c>FirstRunService</c>'s job.
    /// </remarks>
    public SharedSettings Get() => Get(out _);

    /// <summary>The current shared settings, saying whether reading them converted anything.</summary>
    /// <param name="migrated">
    /// <see langword="true"/> when this read turned an older document into the current shape, so
    /// the caller may want to persist it. Nothing has been written yet either way.
    /// </param>
    /// <returns>The settings.</returns>
    public SharedSettings Get(out bool migrated)
    {
        var settings = Load();
        migrated = LibraryMigration.Apply(settings);
        return settings;
    }

    private SharedSettings Load()
    {
        try
        {
            var stored = _db.Read(c => CoreDatabase.ScalarString(
                c,
                "SELECT value_json FROM settings WHERE key = $k;",
                ("$k", SharedSettings.StorageKey)));

            if (string.IsNullOrWhiteSpace(stored))
            {
                return SharedSettings.CreateDefault();
            }

            return JsonSerializer.Deserialize<SharedSettings>(stored, _json) ?? SharedSettings.CreateDefault();
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            // Falling back to defaults rather than throwing keeps a node with a corrupted settings
            // row bootable; the user can then re-save through the API.
            _logger.LogError(ex, "Could not read shared settings; falling back to defaults");
            return SharedSettings.CreateDefault();
        }
    }

    /// <summary>Persist the shared settings, stamping the revision and timestamp.</summary>
    public async Task<SharedSettings> SaveAsync(SharedSettings settings, CancellationToken cancellationToken = default)
    {
        settings.Revision++;
        settings.UpdatedAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        var json = JsonSerializer.Serialize(settings, _json);

        await _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO settings (key, value_json, updated_at) VALUES ($k, $v, $t)
                ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at;
                """,
                ("$k", SharedSettings.StorageKey),
                ("$v", json),
                ("$t", settings.UpdatedAt)),
            cancellationToken).ConfigureAwait(false);

        return settings;
    }

    /// <summary>
    /// Read the settings, change them, and save them, with no other gated write in between.
    /// </summary>
    /// <param name="change">The edit. Runs against a fresh read, under the gate.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The saved settings.</returns>
    public async Task<SharedSettings> UpdateAsync(
        Action<SharedSettings> change,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(change);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var settings = Get();
            change(settings);
            return await SaveAsync(settings, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Save what a layout pass learned about each library, and nothing else it happened to read.
    /// </summary>
    /// <param name="snapshot">The settings the pass read when it started, with its findings on them.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The saved settings.</returns>
    /// <remarks>
    /// <para>
    /// A layout pass reads the settings, spends seconds talking to the media server, and then has
    /// three things per library worth keeping: <see cref="LibrarySettings.FolderName"/>,
    /// <see cref="LibrarySettings.JellyfinItemId"/> and <see cref="LibrarySettings.ManagedLocations"/>.
    /// It used to save its whole snapshot. When a reader pressed a library's switch during that pass,
    /// the snapshot still held the old value, and saving it put the switch back where it had been:
    /// the flip Dan saw on 2026-09-22.
    /// </para>
    /// <para>
    /// So this copies only those three fields, by library id, onto the settings as they are now. A
    /// library the snapshot has and the store no longer does was removed meanwhile and is skipped.
    /// </para>
    /// </remarks>
    public async Task<SharedSettings> SaveLibraryBookkeepingAsync(
        SharedSettings snapshot,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var current = Get(out var migrated);
            if (migrated)
            {
                // Nothing has saved the library list yet, so nobody can have pressed a switch
                // since the pass read it, and the migration's rows carry fresh ids on every read.
                // The snapshot is the only copy whose ids the pass's findings are attached to.
                return await SaveAsync(snapshot, cancellationToken).ConfigureAwait(false);
            }

            foreach (var library in current.Libraries)
            {
                var learned = snapshot.Libraries.Find(
                    l => string.Equals(l.Id, library.Id, StringComparison.OrdinalIgnoreCase));
                if (learned is null)
                {
                    continue;
                }

                library.FolderName = learned.FolderName;
                library.JellyfinItemId = learned.JellyfinItemId;
                library.ManagedLocations = new List<string>(learned.ManagedLocations);
            }

            return await SaveAsync(current, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <inheritdoc />
    public void Dispose() => _gate.Dispose();

    /// <summary>Read an arbitrary JSON document by key.</summary>
    public T? GetDocument<T>(string key)
        where T : class
    {
        var stored = _db.Read(c => CoreDatabase.ScalarString(
            c,
            "SELECT value_json FROM settings WHERE key = $k;",
            ("$k", key)));
        if (string.IsNullOrWhiteSpace(stored))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<T>(stored, _json);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Could not deserialize settings document {Key}", key);
            return null;
        }
    }

    /// <summary>Write an arbitrary JSON document by key.</summary>
    public Task PutDocumentAsync<T>(string key, T value, CancellationToken cancellationToken = default)
        => _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO settings (key, value_json, updated_at) VALUES ($k, $v, $t)
                ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at;
                """,
                ("$k", key),
                ("$v", JsonSerializer.Serialize(value, _json)),
                ("$t", DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture))),
            cancellationToken);

    /// <summary>Record the outcome of a sync into one app.</summary>
    public Task RecordSyncAsync(SyncStatus status, CancellationToken cancellationToken = default)
    {
        status.UpdatedAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        return _db.WriteAsync(
            c => CoreDatabase.Execute(
                c,
                """
                INSERT INTO sync_status (app, ok, message, detail, updated_at)
                VALUES ($a, $o, $m, $d, $t)
                ON CONFLICT(app) DO UPDATE SET
                    ok = excluded.ok, message = excluded.message,
                    detail = excluded.detail, updated_at = excluded.updated_at;
                """,
                ("$a", status.App),
                ("$o", status.Ok ? 1 : 0),
                ("$m", status.Message),
                ("$d", JsonSerializer.Serialize(status.Detail, _json)),
                ("$t", status.UpdatedAt)),
            cancellationToken);
    }

    /// <summary>Every recorded sync outcome.</summary>
    public List<SyncStatus> SyncStatuses()
    {
        return _db.Read(c => CoreDatabase.Query(
            c,
            "SELECT app, ok, message, detail, updated_at FROM sync_status ORDER BY app;",
            r => new SyncStatus
            {
                App = r.GetString(0),
                Ok = r.GetInt64(1) != 0,
                Message = r.GetString(2),
                Detail = SafeDetail(r.GetString(3)),
                UpdatedAt = r.GetString(4),
            }));
    }

    private static List<string> SafeDetail(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<List<string>>(json, _json) ?? new List<string>();
        }
        catch (JsonException)
        {
            return new List<string>();
        }
    }
}
