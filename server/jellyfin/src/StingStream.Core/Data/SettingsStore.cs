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
public sealed class SettingsStore
{
    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
    };

    private readonly CoreDatabase _db;
    private readonly ILogger<SettingsStore> _logger;

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
    public SharedSettings Get()
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
