using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;
using StingStream.Core.Data;
using StingStream.Core.Inventory;
using StingStream.Core.Library;

namespace StingStream.Core.Webhooks;

/// <summary>
/// Handles the Grab / Download / Rename / Delete events Radarr and Sonarr post to StingStream.
/// </summary>
/// <remarks>
/// The reason this exists rather than letting Jellyfin's scheduled library scan find new files:
/// a scan walks every library folder and re-reads everything, which on a large library is minutes
/// of disk churn to notice one new file. The arr already knows exactly which path it just wrote,
/// so an import triggers a refresh of *that path* and nothing else. New items appear in seconds
/// instead of on the next scan cycle.
///
/// Every delivery is also recorded in <c>core.db</c>, because "the file imported but never
/// appeared in Jellyfin" is the failure this pipeline has, and the recorded payload is what makes
/// it diagnosable.
/// </remarks>
public sealed class ArrWebhookService
{
    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly ILibraryManager _library;
    private readonly ILibraryMonitor _monitor;
    private readonly IPathRefresher _refresher;
    private readonly IInventoryService _inventory;
    private readonly HashingService _hashing;
    private readonly CoreDatabase _db;
    private readonly ILogger<ArrWebhookService> _logger;

    public ArrWebhookService(
        ILibraryManager library,
        ILibraryMonitor monitor,
        IPathRefresher refresher,
        IInventoryService inventory,
        HashingService hashing,
        CoreDatabase db,
        ILogger<ArrWebhookService> logger)
    {
        _library = library;
        _monitor = monitor;
        _refresher = refresher;
        _inventory = inventory;
        _hashing = hashing;
        _db = db;
        _logger = logger;
    }

    /// <summary>Process one webhook delivery.</summary>
    /// <param name="app">Which app sent it, from the query string the sync service configures.</param>
    /// <param name="payload">The raw JSON body.</param>
    public async Task<WebhookResult> HandleAsync(string? app, JsonNode? payload, CancellationToken cancellationToken)
    {
        var eventType = payload?["eventType"]?.GetValue<string>() ?? "Unknown";
        var source = string.IsNullOrWhiteSpace(app) ? InferApp(payload) : app;

        var recordId = await RecordAsync(source, eventType, payload, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation("Received a {Event} webhook from {App}", eventType, source);

        var result = new WebhookResult { App = source, EventType = eventType };

        switch (eventType)
        {
            // "Test" is what the arrs send when a user presses Test on the notification. Answering
            // 200 is the whole contract.
            case "Test":
                result.Message = "ok";
                break;

            // Both apps call the import event "Download" -- there is no "Import" event in either.
            // Sonarr additionally fires "ImportComplete" once per batch.
            case "Download":
            case "ImportComplete":
            case "Rename":
            case "MovieFileImported":
                await RefreshPathsAsync(CollectPaths(payload), result, cancellationToken).ConfigureAwait(false);
                break;

            case "MovieDelete":
            case "MovieFileDelete":
            case "SeriesDelete":
            case "EpisodeFileDelete":
                await RefreshPathsAsync(CollectPaths(payload), result, cancellationToken).ConfigureAwait(false);
                result.Message = "refreshed after delete";
                break;

            case "Grab":
                // Nothing to refresh yet: the file does not exist. Recorded so a grab that never
                // becomes an import can be traced.
                result.Message = "grab recorded";
                break;

            default:
                result.Message = $"no action for event type {eventType}";
                break;
        }

        await MarkHandledAsync(recordId, result.Message, cancellationToken).ConfigureAwait(false);
        return result;
    }

    private static string InferApp(JsonNode? payload)
    {
        if (payload?["movie"] is not null)
        {
            return "radarr";
        }

        return payload?["series"] is not null ? "sonarr" : "unknown";
    }

    /// <summary>
    /// Pull every filesystem path out of a webhook payload.
    /// </summary>
    /// <remarks>
    /// The two apps put paths in different places and each shape has changed across versions, so
    /// this reads all of the known ones and de-duplicates rather than switching on the app:
    /// <c>movie.folderPath</c>, <c>series.path</c>, <c>movieFile.path</c>,
    /// <c>episodeFile.path</c>, <c>episodeFiles[].path</c>, and the <c>*.relativePath</c> variants
    /// that have to be combined with the parent folder.
    /// </remarks>
    public static List<string> CollectPaths(JsonNode? payload)
    {
        var paths = new List<string>();
        if (payload is not JsonObject root)
        {
            return paths;
        }

        void AddIfPresent(JsonNode? node, string property)
        {
            var value = node?[property]?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(value))
            {
                paths.Add(value);
            }
        }

        void AddRelative(JsonNode? node, string? parentFolder)
        {
            var relative = node?["relativePath"]?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(relative) && !string.IsNullOrWhiteSpace(parentFolder))
            {
                paths.Add(Path.Combine(parentFolder, relative));
            }
        }

        var movieFolder = root["movie"]?["folderPath"]?.GetValue<string>();
        var seriesFolder = root["series"]?["path"]?.GetValue<string>();

        AddIfPresent(root["movieFile"], "path");
        AddRelative(root["movieFile"], movieFolder);
        AddIfPresent(root["episodeFile"], "path");
        AddRelative(root["episodeFile"], seriesFolder);

        if (root["episodeFiles"] is JsonArray episodeFiles)
        {
            foreach (var file in episodeFiles.OfType<JsonObject>())
            {
                AddIfPresent(file, "path");
                AddRelative(file, seriesFolder);
            }
        }

        // Rename events carry the previous path, which has to be refreshed too or Jellyfin keeps
        // an item pointing at a file that no longer exists.
        if (root["renamedMovieFiles"] is JsonArray renamedMovies)
        {
            foreach (var file in renamedMovies.OfType<JsonObject>())
            {
                AddIfPresent(file, "previousPath");
                AddIfPresent(file, "path");
                AddRelative(file, movieFolder);
            }
        }

        if (root["renamedEpisodeFiles"] is JsonArray renamedEpisodes)
        {
            foreach (var file in renamedEpisodes.OfType<JsonObject>())
            {
                AddIfPresent(file, "previousPath");
                AddIfPresent(file, "path");
                AddRelative(file, seriesFolder);
            }
        }

        // Fall back to the containing folder when no file path was given at all, which is what a
        // delete event looks like.
        if (paths.Count == 0)
        {
            if (!string.IsNullOrWhiteSpace(movieFolder))
            {
                paths.Add(movieFolder);
            }

            if (!string.IsNullOrWhiteSpace(seriesFolder))
            {
                paths.Add(seriesFolder);
            }
        }

        return paths.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>
    /// Refresh exactly the paths an import touched, and nothing else.
    /// </summary>
    /// <remarks>
    /// The resolution itself lives in <see cref="IPathRefresher"/>, which is also where the reason
    /// it works downwards rather than upwards is written down. M3b's federated materializer has
    /// exactly the same problem -- it writes files into a library folder and needs them to become
    /// items now -- so the two share it. What is left here is the per-delivery bookkeeping: a path
    /// outside every library is handed to the filesystem watcher instead, and a path that did
    /// resolve gets its hash and its inventory record caught up.
    /// </remarks>
    private async Task RefreshPathsAsync(List<string> paths, WebhookResult result, CancellationToken cancellationToken)
    {
        if (paths.Count == 0)
        {
            result.Message = "no paths in the payload";
            return;
        }

        var refreshed = new List<string>();
        foreach (var path in paths)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var name = await _refresher.RefreshAsync(path, cancellationToken).ConfigureAwait(false);
                if (name is null)
                {
                    // Nothing on this path belongs to any library. Tell the monitor anyway -- it
                    // costs nothing and covers a layout this code has not anticipated.
                    _monitor.ReportFileSystemChanged(path);
                    result.Notified.Add(path);
                    _logger.LogInformation(
                        "{Path} is not inside any library; notified the library monitor instead",
                        path);
                    continue;
                }

                refreshed.Add(name);
                await AfterRefreshAsync(path, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is IOException or InvalidOperationException or UnauthorizedAccessException)
            {
                _logger.LogWarning(ex, "Could not refresh {Path}", path);
                result.Errors.Add($"{path}: {ex.Message}");
            }
        }

        result.Refreshed.AddRange(refreshed);
        result.Message = refreshed.Count > 0
            ? $"refreshed {refreshed.Count} item(s)"
            : "notified the library monitor";
    }

    /// <summary>
    /// After a refresh, catch up the parts of the record that depend on the item existing:
    /// the BLAKE3 hash and the inventory entry.
    /// </summary>
    private async Task AfterRefreshAsync(string path, CancellationToken cancellationToken)
    {
        if (!File.Exists(path))
        {
            return;
        }

        var item = _library.FindByPath(path, false);
        if (item is null)
        {
            // The refresh may not have resolved the new file yet. Hash it anyway; the inventory
            // record picks the hash up whenever the item does appear.
            await _hashing.EnqueueAsync(path, null, cancellationToken).ConfigureAwait(false);
            return;
        }

        await _hashing.EnqueueAsync(path, item.Id, cancellationToken).ConfigureAwait(false);
        await _inventory.RefreshItemAsync(item.Id, cancellationToken).ConfigureAwait(false);
    }

    // --- event log ---------------------------------------------------------

    private async Task<long> RecordAsync(string app, string eventType, JsonNode? payload, CancellationToken ct)
    {
        long id = 0;
        await _db.WriteAsync(
            c =>
            {
                CoreDatabase.Execute(
                    c,
                    """
                    INSERT INTO arr_events (app, event_type, payload, received_at)
                    VALUES ($a, $e, $p, $t);
                    """,
                    ("$a", app),
                    ("$e", eventType),
                    ("$p", payload?.ToJsonString() ?? "{}"),
                    ("$t", DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture)));
                id = CoreDatabase.ScalarLong(c, "SELECT last_insert_rowid();") ?? 0;

                // Keep the log bounded: this is a diagnostic tail, not an archive.
                CoreDatabase.Execute(
                    c,
                    """
                    DELETE FROM arr_events WHERE id NOT IN (
                        SELECT id FROM arr_events ORDER BY id DESC LIMIT 500
                    );
                    """);
            },
            ct).ConfigureAwait(false);
        return id;
    }

    private Task MarkHandledAsync(long id, string note, CancellationToken ct)
        => id == 0
            ? Task.CompletedTask
            : _db.WriteAsync(
                c => CoreDatabase.Execute(
                    c,
                    "UPDATE arr_events SET handled = 1, note = $n WHERE id = $i;",
                    ("$i", id),
                    ("$n", note)),
                ct);

    /// <summary>The most recent webhook deliveries, newest first.</summary>
    public List<ArrEvent> RecentEvents(int limit = 50)
        => _db.Read(c => CoreDatabase.Query(
            c,
            "SELECT id, app, event_type, received_at, handled, note FROM arr_events ORDER BY id DESC LIMIT $l;",
            r => new ArrEvent
            {
                Id = r.GetInt64(0),
                App = r.GetString(1),
                EventType = r.GetString(2),
                ReceivedAt = r.GetString(3),
                Handled = r.GetInt64(4) != 0,
                Note = r.IsDBNull(5) ? null : r.GetString(5),
            },
            ("$l", Math.Clamp(limit, 1, 500))));
}

/// <summary>What a webhook delivery did.</summary>
public sealed class WebhookResult
{
    public string App { get; set; } = string.Empty;

    public string EventType { get; set; } = string.Empty;

    public string Message { get; set; } = string.Empty;

    /// <summary>Items whose metadata was refreshed.</summary>
    public List<string> Refreshed { get; } = new();

    /// <summary>Paths the library monitor was told about, because nothing on them was known yet.</summary>
    public List<string> Notified { get; } = new();

    public List<string> Errors { get; } = new();
}

/// <summary>A recorded webhook delivery.</summary>
public sealed class ArrEvent
{
    public long Id { get; set; }

    public string App { get; set; } = string.Empty;

    public string EventType { get; set; } = string.Empty;

    public string ReceivedAt { get; set; } = string.Empty;

    public bool Handled { get; set; }

    public string? Note { get; set; }
}
