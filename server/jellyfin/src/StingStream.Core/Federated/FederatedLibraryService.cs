using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Inventory;
using StingStream.Core.Library;
using StingStream.Core.Mesh;

namespace StingStream.Core.Federated;

/// <summary>
/// Turns the group index into real items in this node's own Jellyfin.
/// </summary>
/// <remarks>
/// This is the merge mechanism. Instead of proxying another server's API, each node writes the
/// titles its peers hold into two of its *own* libraries as <c>.strm</c> pointer files with
/// <c>.nfo</c> sidecars and real artwork, so every native Jellyfin feature — search, collections,
/// watched state, SyncPlay, the clients themselves — works on a peer's film exactly as it does on
/// a local one, with nothing to keep in step with upstream. The pattern is proven: the whole
/// debrid ecosystem runs libraries of hundreds of thousands of items this way.
///
/// One pass is a set comparison:
///
/// 1. Read the merged index for every group, drop this node's own rows and anything it already
///    holds locally (the local file wins; the remote copy is still in the index for pin, dedupe
///    and M4's failover).
/// 2. Write, update or delete pointer files so the tree on disk matches.
/// 3. Refresh only the folders that changed, resolving downwards through
///    <see cref="IPathRefresher"/> rather than triggering a library scan.
/// 4. Stamp MediaStreams, runtime and container onto each resulting item from the index record, so
///    resolution and codec badges appear without probing anything over the network.
/// 5. Tag the versions of an offline peer <c>stingstream:unavailable</c>, clear the tag when it
///    returns, and delete the pointer once the peer has been gone longer than the grace period.
///
/// The pass is idempotent and cheap when nothing changed, which is what lets it run on a short
/// timer instead of needing a change feed out of the mesh.
/// </remarks>
public sealed class FederatedLibraryService : BackgroundService
{
    /// <summary>Tag carried by every federated item, from the <c>.nfo</c>.</summary>
    public const string FederatedTag = NfoWriter.FederatedTag;

    /// <summary>Tag added to a version whose holder is not currently reachable.</summary>
    public const string UnavailableTag = "stingstream:unavailable";

    private readonly IMeshClient _mesh;
    private readonly IInventoryService _inventory;
    private readonly FederatedStore _store;
    private readonly IPathRefresher _refresher;
    private readonly ILibraryManager _library;
    private readonly IMediaStreamRepository _mediaStreams;
    private readonly INodeRuntimeProvider _runtime;
    private readonly SettingsStore _settings;
    private readonly ILogger<FederatedLibraryService> _logger;

    private bool _librariesEnsured;

    public FederatedLibraryService(
        IMeshClient mesh,
        IInventoryService inventory,
        FederatedStore store,
        IPathRefresher refresher,
        ILibraryManager library,
        IMediaStreamRepository mediaStreams,
        INodeRuntimeProvider runtime,
        SettingsStore settings,
        ILogger<FederatedLibraryService> logger)
    {
        _mesh = mesh;
        _inventory = inventory;
        _store = store;
        _refresher = refresher;
        _library = library;
        _mediaStreams = mediaStreams;
        _runtime = runtime;
        _settings = settings;
        _logger = logger;
    }

    /// <summary>How many pointer files the last pass wrote, for the status API.</summary>
    public int LastWritten { get; private set; }

    /// <summary>How many pointer files the last pass removed.</summary>
    public int LastRemoved { get; private set; }

    /// <summary>When the last pass finished, RFC 3339.</summary>
    public string? LastPassAt { get; private set; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var federatedRoot = FederatedRoot();
        if (federatedRoot is null)
        {
            _logger.LogInformation(
                "No StingStream data directory, so there is no federated library. This node runs standalone.");
            return;
        }

        if (!await _mesh.WaitUntilReadyAsync(TimeSpan.FromMinutes(3), stoppingToken).ConfigureAwait(false))
        {
            _logger.LogWarning("The mesh never answered; the federated library will start when it does");
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            var settings = Settings();
            try
            {
                if (settings.Enabled)
                {
                    await RunPassAsync(stoppingToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // One bad pass must not stop the service: the mesh may be restarting, a peer may
                // have sent something unexpected, or a file may be locked. The next pass retries,
                // and every step below is idempotent.
                _logger.LogError(ex, "A federated library pass failed");
            }

            var interval = TimeSpan.FromSeconds(Math.Clamp(settings.PollIntervalSeconds, 2, 3600));
            await Task.Delay(interval, stoppingToken).ConfigureAwait(false);
        }
    }

    private FederatedSettings Settings()
    {
        try
        {
            return _settings.Get().Federated;
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            _logger.LogDebug(ex, "Could not read the federated settings; using defaults");
            return new FederatedSettings();
        }
    }

    private string? FederatedRoot()
    {
        var configured = _runtime.Current?.Paths.Federated;
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        var dataDir = _runtime.DataDirectory;
        return string.IsNullOrWhiteSpace(dataDir) ? null : Path.Combine(dataDir, "federated");
    }

    // --- one pass ----------------------------------------------------------

    /// <summary>Run one materialization pass. Public so the API can force one.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A short report.</returns>
    public async Task<FederatedReport> RunPassAsync(CancellationToken cancellationToken)
    {
        var report = new FederatedReport();
        var root = FederatedRoot();
        if (root is null)
        {
            return report;
        }

        var groups = await _mesh.GroupsAsync(cancellationToken).ConfigureAwait(false);
        var known = _store.All();

        if (groups.Count == 0)
        {
            // Not in any group any more. Everything materialized belongs to a group this node has
            // left, so take it down rather than leaving orphans in the library forever.
            foreach (var pointer in known)
            {
                await RemovePointerAsync(pointer, report, cancellationToken).ConfigureAwait(false);
            }

            await RefreshAsync(report, cancellationToken).ConfigureAwait(false);
            Record(report);
            return report;
        }

        await EnsureLibrariesAsync(root, cancellationToken).ConfigureAwait(false);

        var status = await _mesh.StatusAsync(cancellationToken).ConfigureAwait(false);
        var selfNode = status?.Node ?? string.Empty;
        var localKeys = new HashSet<string>(_inventory.Keys, StringComparer.Ordinal);
        var settings = Settings();

        var desired = new Dictionary<(string, string, string), MeshIndexEntry>();
        var online = new Dictionary<(string Group, string Node), bool>();
        var groupIds = new HashSet<string>(StringComparer.Ordinal);

        foreach (var group in groups)
        {
            cancellationToken.ThrowIfCancellationRequested();
            groupIds.Add(group.Group);

            foreach (var peer in await _mesh.PeersAsync(group.Group, cancellationToken).ConfigureAwait(false))
            {
                online[(group.Group, peer.Node)] = peer.Online;
            }

            var index = await _mesh.IndexAsync(group.Group, cancellationToken).ConfigureAwait(false);
            foreach (var entry in index.Entries)
            {
                if (string.IsNullOrEmpty(entry.Node)
                    || string.Equals(entry.Node, selfNode, StringComparison.OrdinalIgnoreCase))
                {
                    // Our own rows come back in the merged index too. Materializing them would
                    // duplicate every local title as a pointer to ourselves.
                    continue;
                }

                if (localKeys.Contains(entry.ItemKey))
                {
                    // The local file wins in v1. The remote copy stays in the index for dedupe,
                    // pin and M4's same-hash failover; it just does not become an item here.
                    continue;
                }

                if (string.IsNullOrWhiteSpace(entry.ItemKey))
                {
                    continue;
                }

                desired[(group.Group, entry.ItemKey, entry.Node)] = entry;
            }
        }

        var touched = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var byKey = known.ToDictionary(p => p.Key);

        // --- removals, first, so a folder that is being rebuilt is clean before it is rewritten.
        foreach (var pointer in known)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (!groupIds.Contains(pointer.Group))
            {
                await RemovePointerAsync(pointer, report, cancellationToken).ConfigureAwait(false);
                touched.Add(pointer.Folder);
                continue;
            }

            if (desired.ContainsKey(pointer.Key))
            {
                continue;
            }

            // The holder no longer advertises it, or this node now holds it locally. Either way
            // the pointer is wrong now, not in seven days: an item that plays nothing is worse
            // than one that is missing.
            await RemovePointerAsync(pointer, report, cancellationToken).ConfigureAwait(false);
            touched.Add(pointer.Folder);
        }

        // --- offline bookkeeping and grace-period removal.
        var graceDays = Math.Max(0, settings.OfflineGraceDays);
        foreach (var pointer in known)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!desired.ContainsKey(pointer.Key))
            {
                continue;
            }

            var isOnline = online.TryGetValue((pointer.Group, pointer.Node), out var value) && value;
            if (isOnline)
            {
                if (pointer.OfflineSince is not null)
                {
                    await _store.SetOfflineSinceAsync(pointer, null, cancellationToken).ConfigureAwait(false);
                    report.CameBack++;
                }

                continue;
            }

            if (pointer.OfflineSince is null)
            {
                await _store.SetOfflineSinceAsync(pointer, FederatedStore.Now(), cancellationToken)
                    .ConfigureAwait(false);
                report.WentOffline++;
                continue;
            }

            var since = FederatedStore.Parse(pointer.OfflineSince);
            if (since is not null && DateTime.UtcNow - since.Value > TimeSpan.FromDays(graceDays))
            {
                _logger.LogInformation(
                    "{Node} has held {ItemKey} but been offline since {Since}; past the {Days}-day "
                    + "grace period, so its pointer is being removed",
                    pointer.NodeName,
                    pointer.ItemKey,
                    pointer.OfflineSince,
                    graceDays);
                await RemovePointerAsync(pointer, report, cancellationToken).ConfigureAwait(false);
                desired.Remove(pointer.Key);
                touched.Add(pointer.Folder);
            }
        }

        // --- writes.
        var folderOwners = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pointer in known)
        {
            if (desired.ContainsKey(pointer.Key))
            {
                folderOwners[pointer.Folder] = pointer.ItemKey;
            }
        }

        foreach (var ((group, itemKey, node), entry) in desired)
        {
            cancellationToken.ThrowIfCancellationRequested();
            byKey.TryGetValue((group, itemKey, node), out var existing);

            // Rewrite when the record moved on, when the files are gone, or when this is new. The
            // timestamp comparison is a string one on purpose: the mesh's `updated_at` is RFC 3339
            // in UTC, which sorts lexicographically in time order.
            var upToDate = existing is not null
                && string.CompareOrdinal(entry.UpdatedAt, existing.UpdatedAt) <= 0
                && File.Exists(existing.StrmPath);
            if (upToDate)
            {
                continue;
            }

            try
            {
                var pointer = await WritePointerAsync(
                        root,
                        group,
                        entry,
                        existing,
                        folderOwners,
                        settings,
                        cancellationToken)
                    .ConfigureAwait(false);
                if (pointer is not null)
                {
                    touched.Add(pointer.Folder);
                    report.Written++;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                          or ArgumentException or NotSupportedException)
            {
                _logger.LogWarning(
                    ex,
                    "Could not materialize {ItemKey} from {Node}",
                    entry.ItemKey,
                    entry.NodeName);
                report.Errors.Add($"{entry.ItemKey}@{entry.NodeName}: {ex.Message}");
            }
        }

        report.Folders.AddRange(touched);
        await RefreshAsync(report, cancellationToken).ConfigureAwait(false);
        await EnrichAsync(online, cancellationToken).ConfigureAwait(false);
        Record(report);
        return report;
    }

    private void Record(FederatedReport report)
    {
        LastWritten = report.Written;
        LastRemoved = report.Removed;
        LastPassAt = FederatedStore.Now();
        if (report.Written > 0 || report.Removed > 0 || report.WentOffline > 0 || report.CameBack > 0)
        {
            _logger.LogInformation(
                "Federated library: {Written} written, {Removed} removed, {Offline} went offline, "
                + "{Back} came back",
                report.Written,
                report.Removed,
                report.WentOffline,
                report.CameBack);
        }
    }

    // --- writing -----------------------------------------------------------

    private async Task<FederatedPointer?> WritePointerAsync(
        string root,
        string group,
        MeshIndexEntry entry,
        FederatedPointer? existing,
        Dictionary<string, string> folderOwners,
        FederatedSettings settings,
        CancellationToken cancellationToken)
    {
        var isEpisode = entry.Metadata.Season is not null
            && entry.Metadata.Episode is not null
            && !string.IsNullOrWhiteSpace(entry.Metadata.SeriesName);

        var label = FederatedLayout.VersionLabel(entry.NodeName, entry.Node, entry.Media.Resolution);
        var libraryRoot = Path.Combine(
            root,
            isEpisode ? FederatedLayout.TvDirectory : FederatedLayout.MoviesDirectory);

        string folder;
        string fileBase;
        string titleFolder;

        if (isEpisode)
        {
            var seriesName = Unique(
                FederatedLayout.SeriesFolderName(entry),
                SeriesIdentity(entry),
                folderOwners,
                libraryRoot);
            titleFolder = Path.Combine(libraryRoot, seriesName);
            folder = Path.Combine(titleFolder, SafePath.SeasonFolder(entry.Metadata.Season!.Value));
            fileBase = FederatedLayout.EpisodeFileBase(
                seriesName,
                entry.Metadata.Season!.Value,
                entry.Metadata.Episode!.Value,
                label);
        }
        else
        {
            var folderName = Unique(
                FederatedLayout.MovieFolderName(entry),
                entry.ItemKey,
                folderOwners,
                libraryRoot);
            titleFolder = Path.Combine(libraryRoot, folderName);
            folder = titleFolder;
            fileBase = FederatedLayout.MovieFileBase(folderName, label);
        }

        // Belt and braces over SafePath: whatever the components turned out to be, the result must
        // still be inside this node's federated tree before a single byte is written.
        if (!SafePath.IsUnder(root, folder))
        {
            _logger.LogWarning(
                "Refusing to materialize {ItemKey}: {Folder} is not under {Root}",
                entry.ItemKey,
                folder,
                root);
            return null;
        }

        Directory.CreateDirectory(folder);
        var strmPath = Path.Combine(folder, fileBase + ".strm");

        // If the pointer moved -- a peer renamed a title, say -- take the old files down first so
        // the library does not end up with both.
        if (existing is not null
            && !string.Equals(existing.StrmPath, strmPath, StringComparison.OrdinalIgnoreCase))
        {
            DeletePointerFiles(existing);
        }

        FederatedLayout.WriteStrm(strmPath, FederatedLayout.StreamUrl(group, entry.ItemKey, entry.Node));

        if (isEpisode)
        {
            NfoWriter.WriteEpisode(Path.Combine(folder, fileBase + ".nfo"), entry);
            var seriesNfo = Path.Combine(titleFolder, "tvshow.nfo");
            if (!File.Exists(seriesNfo))
            {
                NfoWriter.WriteSeries(seriesNfo, entry);
            }
        }
        else
        {
            NfoWriter.WriteMovie(Path.Combine(folder, fileBase + ".nfo"), entry);
            // Jellyfin prefers `movie.nfo` when the folder is not "mixed", and falls back to the
            // per-file name when it is. Which of those a folder of alternate versions counts as
            // depends on how the resolver grouped them, so write both; the content is identical
            // because the metadata is the title's, not the version's.
            NfoWriter.WriteMovie(Path.Combine(titleFolder, "movie.nfo"), entry);
        }

        if (settings.FetchImages)
        {
            await FetchImagesAsync(group, entry, folder, titleFolder, fileBase, isEpisode, cancellationToken)
                .ConfigureAwait(false);
        }

        var pointer = new FederatedPointer
        {
            Group = group,
            ItemKey = entry.ItemKey,
            Node = entry.Node,
            NodeName = entry.NodeName ?? string.Empty,
            Kind = isEpisode ? "episode" : "movie",
            Quality = entry.Media.Resolution ?? string.Empty,
            Folder = folder,
            StrmPath = strmPath,
            FileHash = entry.FileHash,
            UpdatedAt = entry.UpdatedAt,
            WrittenAt = FederatedStore.Now(),
            OfflineSince = existing?.OfflineSince,
        };
        await _store.SaveAsync(pointer, cancellationToken).ConfigureAwait(false);
        folderOwners[folder] = isEpisode ? SeriesIdentity(entry) : entry.ItemKey;

        _logger.LogDebug(
            "Materialized {ItemKey} from {Node} at {Path}",
            entry.ItemKey,
            pointer.NodeName,
            strmPath);
        return pointer;
    }

    /// <summary>
    /// The identity a series folder is keyed on, so two different series with the same name do not
    /// share one folder.
    /// </summary>
    private static string SeriesIdentity(MeshIndexEntry entry)
    {
        foreach (var pair in entry.Metadata.ProviderIds)
        {
            if (pair.Length >= 2 && pair[0].StartsWith("series_", StringComparison.OrdinalIgnoreCase))
            {
                return $"series:{pair[0]["series_".Length..].ToLowerInvariant()}:{pair[1]}";
            }
        }

        // No series provider ids: fall back to the episode key's own provider half, which every
        // episode of one series shares (`episode:tvdb:73739:s01e01` -> `episode:tvdb:73739`).
        var parts = entry.ItemKey.Split(':');
        return parts.Length >= 3 ? string.Join(':', parts[0], parts[1], parts[2]) : entry.ItemKey;
    }

    /// <summary>
    /// Make sure two different titles never land in the same folder.
    /// </summary>
    /// <remarks>
    /// Titles come from peers, and two of them can perfectly reasonably be called the same thing —
    /// two 2019 films named "Aladdin", a remake, or simply a peer that sanitised a name down to
    /// the same string. Merging them into one folder would make Jellyfin treat them as alternate
    /// versions of one item, which is exactly wrong. The disambiguator is derived from the item
    /// key rather than a counter so it is stable across passes and across nodes.
    /// </remarks>
    private static string Unique(
        string preferred,
        string identity,
        Dictionary<string, string> folderOwners,
        string libraryRoot)
    {
        var candidate = Path.Combine(libraryRoot, preferred);
        if (!folderOwners.TryGetValue(candidate, out var owner)
            || string.Equals(owner, identity, StringComparison.Ordinal))
        {
            return preferred;
        }

        return SafePath.Component($"{preferred} [{SafePath.FromItemKey(identity)}]", preferred);
    }

    private async Task FetchImagesAsync(
        string group,
        MeshIndexEntry entry,
        string folder,
        string titleFolder,
        string fileBase,
        bool isEpisode,
        CancellationToken cancellationToken)
    {
        foreach (var url in entry.ImageUrls)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var kind = ImageKind(url);
            if (kind is null)
            {
                continue;
            }

            // Work out the destination first: an episode has no use for a backdrop, and fetching
            // one would be megabytes over someone else's uplink for a file nothing reads.
            string? name;
            string directory;
            if (isEpisode)
            {
                name = FederatedLayout.EpisodeImageName(fileBase, kind);
                directory = folder;
            }
            else
            {
                name = FederatedLayout.MovieImageName(kind);
                directory = titleFolder;
            }

            if (name is null || AnyImageExists(directory, name))
            {
                continue;
            }

            var image = await _mesh.ImageAsync(group, entry.ItemKey, entry.Node, kind, cancellationToken)
                .ConfigureAwait(false);
            if (image is null)
            {
                continue;
            }

            var extension = FederatedLayout.ImageExtension(image.Value.ContentType, image.Value.Bytes);
            var path = Path.Combine(directory, name + extension);
            var tmp = path + ".tmp";
            await File.WriteAllBytesAsync(tmp, image.Value.Bytes, cancellationToken).ConfigureAwait(false);
            File.Move(tmp, path, overwrite: true);
            _logger.LogDebug("Fetched the {Kind} image for {ItemKey} to {Path}", kind, entry.ItemKey, path);
        }

        // A series folder needs its own poster, or the Series item in Shared TV is a blank tile
        // however good the episodes' thumbnails are.
        if (!isEpisode)
        {
            return;
        }

        foreach (var url in entry.ImageUrls)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var kind = ImageKind(url);
            var name = kind is null ? null : FederatedLayout.SeriesImageName(kind);
            if (kind is null || name is null || AnyImageExists(titleFolder, name))
            {
                continue;
            }

            var image = await _mesh.ImageAsync(group, entry.ItemKey, entry.Node, kind, cancellationToken)
                .ConfigureAwait(false);
            if (image is null)
            {
                continue;
            }

            var extension = FederatedLayout.ImageExtension(image.Value.ContentType, image.Value.Bytes);
            var path = Path.Combine(titleFolder, name + extension);
            var tmp = path + ".tmp";
            await File.WriteAllBytesAsync(tmp, image.Value.Bytes, cancellationToken).ConfigureAwait(false);
            File.Move(tmp, path, overwrite: true);
        }
    }

    /// <summary>The image kind out of a peer image route (<c>/peer/v1/image/{item_key}/{kind}</c>).</summary>
    private static string? ImageKind(string url)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return null;
        }

        var slash = url.LastIndexOf('/');
        if (slash < 0 || slash == url.Length - 1)
        {
            return null;
        }

        var kind = url[(slash + 1)..].Trim().ToLowerInvariant();
        // Anything else is a peer sending something this node does not know how to place.
        return kind is "primary" or "backdrop" or "logo" or "thumb" or "banner" ? kind : null;
    }

    private static bool AnyImageExists(string directory, string name)
    {
        foreach (var extension in FederatedLayout.ImageExtensions)
        {
            if (File.Exists(Path.Combine(directory, name + extension)))
            {
                return true;
            }
        }

        return false;
    }

    // --- removal -----------------------------------------------------------

    private async Task RemovePointerAsync(
        FederatedPointer pointer,
        FederatedReport report,
        CancellationToken cancellationToken)
    {
        DeletePointerFiles(pointer);
        await _store.DeleteAsync(pointer, cancellationToken).ConfigureAwait(false);
        report.Removed++;
        report.Folders.Add(pointer.Folder);
        _logger.LogInformation(
            "Removed the federated pointer for {ItemKey} from {Node}",
            pointer.ItemKey,
            string.IsNullOrEmpty(pointer.NodeName) ? pointer.Node : pointer.NodeName);
    }

    /// <summary>
    /// Delete one pointer's files, and any folder they leave empty.
    /// </summary>
    /// <remarks>
    /// Only files this materializer wrote are touched, and only ones whose names it can derive
    /// from the stored row — never a wildcard sweep of the folder. A user who dropped a real file
    /// into a Shared library (which they should not, but might) keeps it.
    /// </remarks>
    private void DeletePointerFiles(FederatedPointer pointer)
    {
        var folder = pointer.Folder;
        var fileBase = Path.GetFileNameWithoutExtension(pointer.StrmPath);
        if (string.IsNullOrEmpty(folder) || string.IsNullOrEmpty(fileBase))
        {
            return;
        }

        TryDelete(pointer.StrmPath);
        TryDelete(Path.Combine(folder, fileBase + ".nfo"));
        foreach (var extension in FederatedLayout.ImageExtensions)
        {
            TryDelete(Path.Combine(folder, fileBase + "-thumb" + extension));
        }

        // Walk up while the folders this pointer created are empty: the season folder, then the
        // series or title folder (with its shared movie.nfo / tvshow.nfo and artwork).
        TryRemoveEmptyFolder(folder, depth: 0);
    }

    private void TryRemoveEmptyFolder(string folder, int depth)
    {
        if (depth > 2 || string.IsNullOrEmpty(folder) || !Directory.Exists(folder))
        {
            return;
        }

        try
        {
            var entries = Directory.GetFileSystemEntries(folder);
            // A folder whose only remaining files are the sidecars this materializer wrote for a
            // title that no longer has a single version is not "in use" -- it is a leftover.
            var leftovers = entries.Where(e =>
            {
                var name = Path.GetFileName(e);
                if (Directory.Exists(e))
                {
                    return true;
                }

                if (string.Equals(name, "movie.nfo", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "tvshow.nfo", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "season.nfo", StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }

                var stem = Path.GetFileNameWithoutExtension(name);
                var extension = Path.GetExtension(name);
                var isArtwork = FederatedLayout.ImageExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase)
                    && (stem.Equals("poster", StringComparison.OrdinalIgnoreCase)
                        || stem.Equals("fanart", StringComparison.OrdinalIgnoreCase)
                        || stem.Equals("logo", StringComparison.OrdinalIgnoreCase)
                        || stem.Equals("banner", StringComparison.OrdinalIgnoreCase)
                        || stem.Equals("landscape", StringComparison.OrdinalIgnoreCase));
                return !isArtwork;
            }).ToList();

            if (leftovers.Count > 0)
            {
                return;
            }

            Directory.Delete(folder, recursive: true);
            var parent = Path.GetDirectoryName(folder);
            if (parent is not null)
            {
                TryRemoveEmptyFolder(parent, depth + 1);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogDebug(ex, "Could not clean up {Folder}", folder);
        }
    }

    private void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogDebug(ex, "Could not delete {Path}", path);
        }
    }

    // --- refresh and enrichment --------------------------------------------

    private async Task RefreshAsync(FederatedReport report, CancellationToken cancellationToken)
    {
        // Deepest first. Refreshing a season folder before its series exists costs an extra
        // resolve round; the other order costs nothing.
        var folders = report.Folders
            .Where(f => !string.IsNullOrEmpty(f))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderByDescending(f => f.Length)
            .ToList();

        foreach (var folder in folders)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                // A folder that has just been deleted still needs its *parent* refreshed, or the
                // item stays in the library pointing at nothing.
                var target = Directory.Exists(folder) ? folder : Path.GetDirectoryName(folder);
                if (string.IsNullOrEmpty(target))
                {
                    continue;
                }

                await _refresher.RefreshAsync(target, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is IOException or InvalidOperationException
                                          or UnauthorizedAccessException)
            {
                _logger.LogWarning(ex, "Could not refresh {Folder}", folder);
                report.Errors.Add($"{folder}: {ex.Message}");
            }
        }
    }

    /// <summary>
    /// Stamp what the index already told us onto each materialized item, and tag the ones whose
    /// holder is unreachable.
    /// </summary>
    /// <remarks>
    /// Without this a federated title shows no resolution badge, no codec, and no runtime until
    /// something probes it — and probing means pulling the file across the mesh through ffmpeg,
    /// from someone else's disk, to rediscover facts the holder already published. The inventory
    /// record has all of it, so this writes it straight into Jellyfin's own media-stream table.
    ///
    /// It runs on every pass, not only after a write, because a refresh can be what finally makes
    /// an item exist and because the unavailable tag has to follow a peer going up and down.
    /// </remarks>
    private async Task EnrichAsync(
        Dictionary<(string Group, string Node), bool> online,
        CancellationToken cancellationToken)
    {
        foreach (var pointer in _store.All())
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!File.Exists(pointer.StrmPath))
            {
                continue;
            }

            var item = _library.FindByPath(pointer.StrmPath, false);
            if (item is null)
            {
                continue;
            }

            var record = await FindRecordAsync(pointer, cancellationToken).ConfigureAwait(false);
            var isOnline = online.TryGetValue((pointer.Group, pointer.Node), out var value) && value;

            try
            {
                var changed = record is not null && StampMedia(item, record);
                changed |= ApplyAvailabilityTag(item, isOnline);
                if (changed)
                {
                    await _library.UpdateItemAsync(
                            item,
                            item.GetParent(),
                            ItemUpdateType.MetadataImport,
                            cancellationToken)
                        .ConfigureAwait(false);
                }
            }
            catch (Exception ex) when (ex is InvalidOperationException or IOException
                                          or Microsoft.Data.Sqlite.SqliteException)
            {
                _logger.LogWarning(ex, "Could not enrich {Path}", pointer.StrmPath);
            }
        }
    }

    private async Task<MeshIndexEntry?> FindRecordAsync(FederatedPointer pointer, CancellationToken cancellationToken)
    {
        var index = await _mesh.IndexAsync(pointer.Group, cancellationToken).ConfigureAwait(false);
        return index.Entries.FirstOrDefault(e =>
            string.Equals(e.ItemKey, pointer.ItemKey, StringComparison.Ordinal)
            && string.Equals(e.Node, pointer.Node, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Write the index record's media summary onto the Jellyfin item.</summary>
    /// <param name="item">The materialized item.</param>
    /// <param name="entry">The index entry it was built from.</param>
    /// <returns>True when the item itself changed and needs persisting.</returns>
    private bool StampMedia(BaseItem item, MeshIndexEntry entry)
    {
        var streams = BuildStreams(entry);
        if (streams.Count > 0)
        {
            var current = _mediaStreams.GetMediaStreams(new MediaStreamQuery { ItemId = item.Id });
            if (!SameStreams(current, streams))
            {
                _mediaStreams.SaveMediaStreams(item.Id, streams, CancellationToken.None);
                _logger.LogDebug("Stamped {Count} media stream(s) onto {Name}", streams.Count, item.Name);
            }
        }

        var changed = false;

        if (entry.Media.DurationMs is { } ms && ms > 0)
        {
            var ticks = ms * TimeSpan.TicksPerMillisecond;
            if (item.RunTimeTicks != ticks)
            {
                item.RunTimeTicks = ticks;
                changed = true;
            }
        }

        if (!string.IsNullOrWhiteSpace(entry.Media.Container)
            && !string.Equals(item.Container, entry.Media.Container, StringComparison.OrdinalIgnoreCase))
        {
            item.Container = entry.Media.Container;
            changed = true;
        }

        if (entry.Media.Size is { } size && size > 0 && item.Size != size)
        {
            item.Size = size;
            changed = true;
        }

        if (entry.Media.Bitrate is { } bitrate && bitrate > 0 && bitrate <= int.MaxValue
            && item.TotalBitrate != (int)bitrate)
        {
            item.TotalBitrate = (int)bitrate;
            changed = true;
        }

        // Width and Height live on the item as well as on the video stream; the library grid reads
        // them from the item, so a badge would otherwise say nothing until something probed.
        if (entry.Media.Width is { } width && width > 0 && item.Width != width)
        {
            item.Width = width;
            changed = true;
        }

        if (entry.Media.Height is { } height && height > 0 && item.Height != height)
        {
            item.Height = height;
            changed = true;
        }

        return changed;
    }

    /// <summary>
    /// Build Jellyfin media streams from the mesh's media summary.
    /// </summary>
    /// <remarks>
    /// Indices must be contiguous from zero — that is what Jellyfin's own probe path does, and the
    /// stream index is what a client sends back when it picks an audio or subtitle track.
    /// </remarks>
    private static List<MediaStream> BuildStreams(MeshIndexEntry entry)
    {
        var streams = new List<MediaStream>();
        var media = entry.Media;

        if (!string.IsNullOrWhiteSpace(media.VideoCodec) || media.Width is > 0 || media.Height is > 0)
        {
            streams.Add(new MediaStream
            {
                Type = MediaStreamType.Video,
                Codec = media.VideoCodec,
                Width = media.Width,
                Height = media.Height,
                BitRate = media.Bitrate is { } b && b <= int.MaxValue ? (int)b : null,
                IsDefault = true,
                IsInterlaced = false,
            });
        }

        foreach (var audio in media.AudioTracks)
        {
            streams.Add(new MediaStream
            {
                Type = MediaStreamType.Audio,
                Codec = audio.Codec,
                Language = audio.Language,
                Channels = audio.Channels,
                Title = audio.Title,
                IsDefault = audio.IsDefault,
            });
        }

        foreach (var subtitle in media.SubtitleTracks)
        {
            streams.Add(new MediaStream
            {
                Type = MediaStreamType.Subtitle,
                Codec = subtitle.Codec,
                Language = subtitle.Language,
                Title = subtitle.Title,
                IsForced = subtitle.Forced,
                // IsExternal false, and IsTextSubtitleStream is computed from the codec by
                // Jellyfin itself -- it has no setter.
                IsExternal = false,
            });
        }

        for (var i = 0; i < streams.Count; i++)
        {
            streams[i].Index = i;
        }

        return streams;
    }

    private static bool SameStreams(IReadOnlyList<MediaStream> a, IReadOnlyList<MediaStream> b)
    {
        if (a.Count != b.Count)
        {
            return false;
        }

        for (var i = 0; i < a.Count; i++)
        {
            if (a[i].Type != b[i].Type
                || !string.Equals(a[i].Codec, b[i].Codec, StringComparison.OrdinalIgnoreCase)
                || a[i].Width != b[i].Width
                || a[i].Height != b[i].Height
                || a[i].Channels != b[i].Channels)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>Add or clear the unavailable tag. Returns true when the item changed.</summary>
    private static bool ApplyAvailabilityTag(BaseItem item, bool isOnline)
    {
        var tags = item.Tags ?? Array.Empty<string>();
        var has = tags.Contains(UnavailableTag, StringComparer.OrdinalIgnoreCase);
        if (isOnline == !has)
        {
            return false;
        }

        item.Tags = isOnline
            ? tags.Where(t => !string.Equals(t, UnavailableTag, StringComparison.OrdinalIgnoreCase)).ToArray()
            : tags.Append(UnavailableTag).ToArray();
        return true;
    }

    // --- libraries ---------------------------------------------------------

    /// <summary>
    /// Create the two Shared libraries, once.
    /// </summary>
    /// <remarks>
    /// Their options are the whole reason they are separate libraries rather than extra folders in
    /// Movies and TV Shows:
    ///
    /// * Every remote metadata and image fetcher is off. The holder already looked all of this up
    ///   and published it; asking TMDB again on every node in the group would be slower, ruder, and
    ///   would produce a *different* answer per node.
    /// * The NFO reader is first, so the sidecars are authoritative.
    /// * There are no metadata savers, because Jellyfin writes NFOs back on every item update and
    ///   would otherwise overwrite the materializer's files with its own.
    ///
    /// They are also never arr root folders: both Radarr and Sonarr treat <c>.strm</c> as a video
    /// file, and pointing one at these folders would have it "import" a peer's pointer.
    /// </remarks>
    private async Task EnsureLibrariesAsync(string root, CancellationToken cancellationToken)
    {
        if (_librariesEnsured)
        {
            return;
        }

        _librariesEnsured = true;

        await EnsureLibraryAsync(
                FederatedLayout.MoviesLibrary,
                CollectionTypeOptions.movies,
                Path.Combine(root, FederatedLayout.MoviesDirectory),
                cancellationToken)
            .ConfigureAwait(false);
        await EnsureLibraryAsync(
                FederatedLayout.TvLibrary,
                CollectionTypeOptions.tvshows,
                Path.Combine(root, FederatedLayout.TvDirectory),
                cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task EnsureLibraryAsync(
        string name,
        CollectionTypeOptions collectionType,
        string path,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(path);

        var existing = _library.GetVirtualFolders();
        if (existing.Any(f =>
                string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase)
                || (f.Locations?.Any(l => SamePath(l, path)) ?? false)))
        {
            return;
        }

        try
        {
            await _library.AddVirtualFolder(name, collectionType, BuildLibraryOptions(path), refreshLibrary: false)
                .ConfigureAwait(false);
            _logger.LogInformation("Created the {Name} library at {Path}", name, path);
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or ArgumentException)
        {
            _logger.LogError(ex, "Could not create the {Name} library at {Path}", name, path);
            _librariesEnsured = false;
        }

        cancellationToken.ThrowIfCancellationRequested();
    }

    /// <summary>Library options that read NFOs and never touch the internet.</summary>
    /// <param name="path">The physical folder.</param>
    /// <returns>The options.</returns>
    public static LibraryOptions BuildLibraryOptions(string path) => new()
    {
        PathInfos = new[] { new MediaPathInfo(path) },
        EnableRealtimeMonitor = false,
        SaveLocalMetadata = false,
        // `MetadataSavers = []` is not cosmetic. Jellyfin runs its savers on every item update, and
        // a saver would rewrite the .nfo this node just materialized -- with Jellyfin's own view of
        // the item, which is derived from that same .nfo, so it would drift a little every pass.
        MetadataSavers = Array.Empty<string>(),
        // The NFO reader, by the name every reader in MediaBrowser.XbmcMetadata reports
        // (BaseNfoSaver.SaverName). Ordinal, case-sensitive: "nfo" would not match.
        LocalMetadataReaderOrder = new[] { "Nfo" },
        DisabledSubtitleFetchers = Array.Empty<string>(),
        SubtitleFetcherOrder = Array.Empty<string>(),
        // Episodes of one series held by different peers must land under one series, which is what
        // Jellyfin's automatic grouping does.
        EnableAutomaticSeriesGrouping = true,
        EnableChapterImageExtraction = false,
        ExtractChapterImagesDuringLibraryScan = false,
        EnableTrickplayImageExtraction = false,
        ExtractTrickplayImagesDuringLibraryScan = false,
        EnableLUFSScan = false,
        // An empty MetadataFetchers/ImageFetchers list is an *allow-list*, so this is what actually
        // turns the internet providers off -- and only a type that has a TypeOptions entry is
        // covered, which is why every type that can appear in these libraries gets one.
        TypeOptions = new[]
        {
            "Movie", "Series", "Season", "Episode", "Video", "BoxSet",
        }.Select(t => new TypeOptions { Type = t }).ToArray(),
    };

    private static bool SamePath(string? a, string? b)
    {
        if (a is null || b is null)
        {
            return false;
        }

        static string Norm(string s) => s.Replace('\\', '/').TrimEnd('/');
        return string.Equals(Norm(a), Norm(b), StringComparison.OrdinalIgnoreCase);
    }
}

/// <summary>What one materialization pass did.</summary>
public sealed class FederatedReport
{
    public int Written { get; set; }

    public int Removed { get; set; }

    public int WentOffline { get; set; }

    public int CameBack { get; set; }

    /// <summary>Folders that changed and therefore need refreshing.</summary>
    public List<string> Folders { get; } = new();

    public List<string> Errors { get; } = new();
}
