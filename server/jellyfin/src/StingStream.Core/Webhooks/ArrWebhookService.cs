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
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Logging;
using StingStream.Core.Data;
using StingStream.Core.Inventory;

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
    private readonly IFileSystem _fileSystem;
    private readonly IInventoryService _inventory;
    private readonly HashingService _hashing;
    private readonly CoreDatabase _db;
    private readonly ILogger<ArrWebhookService> _logger;

    public ArrWebhookService(
        ILibraryManager library,
        ILibraryMonitor monitor,
        IFileSystem fileSystem,
        IInventoryService inventory,
        HashingService hashing,
        CoreDatabase db,
        ILogger<ArrWebhookService> logger)
    {
        _library = library;
        _monitor = monitor;
        _fileSystem = fileSystem;
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
    /// How many resolve-one-level steps to take before giving up on a path.
    /// </summary>
    /// <remarks>
    /// The deepest real layout is library / series / season / episode file: three validation steps
    /// plus the final refresh of the item itself, plus one to materialize the library roots on a
    /// node where that has never happened.
    /// </remarks>
    private const int MaxResolveSteps = 8;

    /// <summary>
    /// Refresh exactly the paths an import touched, and nothing else.
    /// </summary>
    /// <remarks>
    /// The obvious implementation -- walk up to the nearest item Jellyfin already knows about and
    /// refresh it -- does not work for the case that matters most, the *first* import of a title.
    /// Nothing on <c>media/Movies/Title (Year)/Title (Year).mkv</c> is known yet, not even
    /// <c>media/Movies</c>: a library's <c>BaseItem</c> is a <c>CollectionFolder</c> whose own
    /// <c>Path</c> is Jellyfin's internal <c>root/default/&lt;name&gt;</c> virtual folder, so
    /// <see cref="ILibraryManager.FindByPath"/> never matches the media directory on disk.
    /// Jellyfin's own <c>FileRefresher</c> has the same blind spot, which is why handing the path
    /// to <see cref="ILibraryMonitor"/> and hoping is not good enough either -- observed as an
    /// import that landed on disk and simply never appeared.
    ///
    /// So this resolves *downwards* instead. Find the nearest known ancestor -- falling back to the
    /// library that physically owns the path -- validate its direct children, which makes the next
    /// path segment resolvable, and repeat. Each step is one directory listing, so a brand-new
    /// series costs three of them (library, series, season) and every later episode costs one.
    /// That is what makes this targeted rather than a library scan.
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
                var name = await ResolveAndRefreshAsync(path, cancellationToken).ConfigureAwait(false);
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
    /// Walk down to <paramref name="path"/>, validating one level at a time, and refresh whatever
    /// ends up owning it.
    /// </summary>
    /// <returns>The name of the item that was refreshed, or <see langword="null"/> when the path
    /// belongs to no library.</returns>
    private async Task<string?> ResolveAndRefreshAsync(string path, CancellationToken cancellationToken)
    {
        var options = new MetadataRefreshOptions(new DirectoryService(_fileSystem))
        {
            ReplaceAllMetadata = false,
            ImageRefreshMode = MetadataRefreshMode.Default,
            MetadataRefreshMode = MetadataRefreshMode.Default,
            ForceSave = false,
        };

        Guid lastId = default;
        var materialized = false;
        for (var step = 0; step < MaxResolveSteps; step++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var item = FindNearestKnownItem(path);

            // A CollectionFolder is a dead end -- its ValidateChildrenInternal is a deliberate
            // no-op -- and so is nothing at all. Both mean the same thing on a young node: the
            // library's *physical* folder is not an item yet, because Jellyfin materializes those
            // as children of the AggregateFolder during a validation pass and no pass has covered
            // this library since it was created. Do the two cheap steps
            // LibraryManager.PerformLibraryValidation starts with, then look again. Once done, it
            // never needs doing again.
            if (!materialized && item is null or CollectionFolder)
            {
                materialized = true;
                _logger.LogInformation("Resolving the library root folders so {Path} can be located", path);
                await _library.ValidateTopLibraryFolders(cancellationToken).ConfigureAwait(false);
                await _library.RootFolder.ValidateChildren(
                        new Progress<double>(),
                        options,
                        recursive: false,
                        cancellationToken: cancellationToken)
                    .ConfigureAwait(false);
                continue;
            }

            if (item is null)
            {
                return null;
            }

            // The path itself is now a known item: refresh it and stop.
            if (SamePath(item.Path, path))
            {
                await item.RefreshMetadata(options, cancellationToken).ConfigureAwait(false);
                _logger.LogInformation("Refreshed {Item} for {Path}", item.Name, path);
                return item.Path ?? item.Name ?? path;
            }

            if (item is not Folder folder)
            {
                // An ancestor that is not a folder -- a multi-part movie's file, say. Refreshing it
                // is the closest thing to right, and there is nothing further down to resolve.
                await item.RefreshMetadata(options, cancellationToken).ConfigureAwait(false);
                _logger.LogInformation("Refreshed {Item} for {Path}", item.Name, path);
                return item.Path ?? item.Name ?? path;
            }

            if (item.Id.Equals(lastId))
            {
                // Validating that folder taught Jellyfin nothing new about this path, so another
                // pass would loop. Refresh what we have, and hand the path to the monitor as well:
                // this is the branch where a layout we did not anticipate ends up, and the
                // filesystem watcher is the only thing left that might notice.
                await item.RefreshMetadata(options, cancellationToken).ConfigureAwait(false);
                _monitor.ReportFileSystemChanged(path);
                _logger.LogWarning(
                    "Refreshed {Item} ({ItemType} at {ItemPath}), but {Path} did not resolve any "
                    + "further; notified the library monitor instead",
                    item.Name,
                    item.GetType().Name,
                    item.Path,
                    path);
                return item.Path ?? item.Name ?? path;
            }

            lastId = item.Id;
            _logger.LogDebug("Validating the children of {Item} to resolve {Path}", item.Name, path);
            await folder.ValidateChildren(
                    new Progress<double>(),
                    options,
                    recursive: false,
                    cancellationToken: cancellationToken)
                .ConfigureAwait(false);
        }

        _logger.LogWarning("Gave up resolving {Path} after {Steps} steps", path, MaxResolveSteps);
        return null;
    }

    /// <summary>
    /// The nearest item Jellyfin already knows about, starting at the path itself and walking up.
    /// </summary>
    /// <remarks>
    /// A brand-new file has no item of its own, and often neither does its folder — so the walk
    /// ends at the library. That last step needs its own lookup: a library's <c>BaseItem</c> is a
    /// <c>CollectionFolder</c> whose own <c>Path</c> is Jellyfin's internal
    /// <c>root/default/&lt;name&gt;</c> virtual folder, not the media directory on disk, so
    /// <see cref="ILibraryManager.FindByPath"/> never matches it. Without the fallback, every first
    /// import of a title falls through to the filesystem watcher and appears a
    /// <c>LibraryMonitorDelay</c> later instead of in seconds.
    /// </remarks>
    private BaseItem? FindNearestKnownItem(string path)
    {
        var current = path;
        for (var depth = 0; depth < 8 && !string.IsNullOrEmpty(current); depth++)
        {
            // isFolder: null means "either", which is what Jellyfin's own FileRefresher passes --
            // a path that has just appeared may be a file or a directory and guessing wrong makes
            // the lookup miss an item that is right there.
            var item = _library.FindByPath(current, null);
            if (item is not null)
            {
                return item;
            }

            current = Path.GetDirectoryName(current);
        }

        return FindOwningLibrary(path);
    }

    /// <summary>
    /// The folder that owns <paramref name="path"/> when nothing on the path is a known item yet.
    /// </summary>
    /// <remarks>
    /// Returns the library's *physical* folder, not its <c>CollectionFolder</c>. That distinction
    /// is the whole point: a <c>CollectionFolder</c>'s <c>Path</c> is Jellyfin's internal
    /// <c>root/default/&lt;name&gt;</c> virtual folder, and its
    /// <c>ValidateChildrenInternal</c> is a deliberate no-op — validating one discovers nothing at
    /// all. Behind it sits an ordinary <c>Folder</c> whose <c>Path</c> is the media directory on
    /// disk, and that is the thing that can actually resolve a new title.
    /// </remarks>
    private BaseItem? FindOwningLibrary(string path)
    {
        var normalized = Normalize(path);
        try
        {
            // The AggregateFolder's own children *are* the physical library directories -- this is
            // the exact set LibraryManager.PerformLibraryValidation recurses into for a full scan,
            // so it is the right place to start a partial one.
            foreach (var child in _library.RootFolder.Children)
            {
                if (child is Folder folder && IsUnder(normalized, folder.Path))
                {
                    return folder;
                }
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException)
        {
            _logger.LogDebug(ex, "Could not enumerate the root folder looking for {Path}", path);
        }

        try
        {
            foreach (var child in _library.GetUserRootFolder().Children)
            {
                if (child is not CollectionFolder collection
                    || !collection.PhysicalLocations.Any(location => IsUnder(normalized, location)))
                {
                    continue;
                }

                var physical = collection.GetPhysicalFolders()
                    .FirstOrDefault(f => IsUnder(normalized, f.Path));
                if (physical is not null)
                {
                    return physical;
                }

                // Falling back to the CollectionFolder itself is nearly useless -- its
                // ValidateChildrenInternal is a deliberate no-op -- but it is a better anchor for
                // the caller's diagnostics than nothing.
                _logger.LogWarning(
                    "Library {Library} owns {Path} but has no resolved physical folder for it",
                    collection.Name,
                    path);
                return collection;
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException)
        {
            _logger.LogDebug(ex, "Could not find the library owning {Path}", path);
        }

        return null;
    }

    /// <summary>
    /// Reports whether <paramref name="normalizedPath"/> is at or below <paramref name="ancestor"/>.
    /// </summary>
    private static bool IsUnder(string normalizedPath, string? ancestor)
    {
        if (string.IsNullOrEmpty(ancestor))
        {
            return false;
        }

        var prefix = Normalize(ancestor);
        return prefix.Length > 0
            && (normalizedPath.Equals(prefix, StringComparison.OrdinalIgnoreCase)
                || normalizedPath.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase));
    }

    private static string Normalize(string path)
        => path.Replace('\\', '/').TrimEnd('/');

    /// <summary>Reports whether two paths name the same thing.</summary>
    private static bool SamePath(string? a, string? b)
        => a is not null && b is not null
            && Normalize(a).Equals(Normalize(b), StringComparison.OrdinalIgnoreCase);

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
