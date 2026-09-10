using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Federated;

namespace StingStream.Core.Library;

/// <summary>
/// The one place that decides which Jellyfin libraries a node has, and what is in them.
/// </summary>
/// <remarks>
/// <para>
/// A node has <b>one</b> <c>Movies</c> and <b>one</b> <c>TV Shows</c>, each holding two physical
/// paths: the files this node downloaded, and the <c>.strm</c> pointers
/// <see cref="FederatedLibraryService"/> materializes at its peers' files. There is no "Shared
/// Movies". Somebody who installed StingStream has one library of films, and whose disk a
/// particular film sits on is this program's problem rather than theirs.
/// </para>
/// <para>
/// Putting both paths in one collection folder is not only presentational — it is what makes the
/// merge work. <c>Series.CreatePresentationUniqueKey</c> keys a series on its provider id
/// <em>plus the ids of the collection folders it belongs to</em>, so a peer's "Breaking Bad" and
/// the local one collapse into a single series only when they share a folder; a season's key is
/// its series' key plus the index, so seasons follow for free. Movies and episodes do not merge by
/// themselves — <c>BaseItem.CreatePresentationUniqueKey</c> returns the item id — and are linked
/// explicitly by <see cref="VersionMerger"/>.
/// </para>
/// <para>
/// <c>Recordings</c> stays a library of its own, and that is deliberate rather than a leftover: a
/// DVR recording with no <c>ProductionYear</c> cannot satisfy the movie layout's rule that every
/// holder agrees on the year, and one named by its air date has no <c>SxxEyy</c> for the episode
/// resolver — see <see cref="FederatedLayout"/>. Forcing either would produce items that silently
/// fail to group. It is not a "shared" library; there is simply no local counterpart to merge it
/// with.
/// </para>
/// <para>
/// Both the first-run wiring and the materializer call <see cref="EnsureAsync"/>, because either
/// can be the first to run on a given start. It is idempotent and derived from state, so a node
/// interrupted halfway repairs itself on the next call.
/// </para>
/// </remarks>
public sealed class LibraryLayoutService
{
    /// <summary>The one library of films.</summary>
    public const string MoviesLibrary = "Movies";

    /// <summary>The one library of series.</summary>
    public const string TvLibrary = "TV Shows";

    /// <summary>DVR recordings the metadata providers could not identify.</summary>
    public const string RecordingsLibrary = "Recordings";

    private readonly ILibraryManager _library;
    private readonly INodeRuntimeProvider _runtime;
    private readonly SettingsStore _settings;
    private readonly ILogger<LibraryLayoutService> _logger;

    public LibraryLayoutService(
        ILibraryManager library,
        INodeRuntimeProvider runtime,
        SettingsStore settings,
        ILogger<LibraryLayoutService> logger)
    {
        _library = library;
        _runtime = runtime;
        _settings = settings;
        _logger = logger;
    }

    /// <summary>Create or repair the three libraries. Safe to call on every start.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>What it did, for the first-run report.</returns>
    public async Task<LayoutReport> EnsureAsync(CancellationToken cancellationToken)
    {
        var report = new LayoutReport();
        var runtime = _runtime.Current;
        var federatedRoot = FederatedRoot();
        if (federatedRoot is null)
        {
            // No data directory means no supervisor, which means this is a bare Jellyfin somebody
            // is running by hand. Creating libraries under a guessed path is worse than nothing.
            report.Steps.Add("libraries: skipped (no StingStream data directory)");
            return report;
        }

        var roots = RootFolders();
        var movies = Coalesce(roots?.Movies, runtime?.Paths.MediaMovies);
        var tv = Coalesce(roots?.Tv, runtime?.Paths.MediaTv);

        await EnsureOneAsync(
                MoviesLibrary,
                CollectionTypeOptions.movies,
                Paths(movies, Path.Combine(federatedRoot, FederatedLayout.MoviesDirectory)),
                unified: true,
                report,
                cancellationToken)
            .ConfigureAwait(false);

        await EnsureOneAsync(
                TvLibrary,
                CollectionTypeOptions.tvshows,
                Paths(tv, Path.Combine(federatedRoot, FederatedLayout.TvDirectory)),
                unified: true,
                report,
                cancellationToken)
            .ConfigureAwait(false);

        // `CollectionTypeOptions.movies` rather than a mixed library: the resolver's multi-version
        // grouping is what makes two nodes' recordings of one broadcast a single item with two
        // sources, and it only runs for a typed library.
        await EnsureOneAsync(
                RecordingsLibrary,
                CollectionTypeOptions.movies,
                Paths(Path.Combine(federatedRoot, FederatedLayout.RecordingsDirectory)),
                unified: false,
                report,
                cancellationToken)
            .ConfigureAwait(false);

        return report;
    }

    /// <summary>
    /// Options for a library holding both this node's own files and its peers' pointers.
    /// </summary>
    /// <param name="paths">The physical folders, in the order they should be listed.</param>
    /// <returns>The options.</returns>
    /// <remarks>
    /// <para>
    /// The local half and the federated half want opposite things from three of these fields, and
    /// each is resolved here rather than by splitting the library in two again:
    /// </para>
    /// <para>
    /// <b><c>TypeOptions</c> is empty, so internet providers stay on.</b> The direction is the
    /// surprising one: an entry for a type is an <em>allow-list</em>, so a type with an entry and
    /// no fetchers named gets nothing, while a type with no entry at all falls back to the server's
    /// own options and gets everything. Empty is what gives a film somebody downloaded its poster,
    /// its ids and its overview. The pointers are cut off from the internet <em>per item</em>
    /// instead, by the <c>lockdata</c> element <see cref="NfoWriter"/> writes into every federated
    /// NFO — which Jellyfin parses into <c>BaseItem.IsLocked</c>, and which makes
    /// <c>MetadataService</c> skip every remote metadata provider on that refresh.
    /// </para>
    /// <para>
    /// <b><c>MetadataSavers</c> is an empty array and must not be null.</b> With
    /// <c>SaveLocalMetadata</c> off, Jellyfin still runs its NFO saver for any update at or above
    /// <c>MetadataEdit</c> <em>when the .nfo already exists</em> — "save locally anyway if the
    /// metadata file already exists". Every federated pointer has one, so a null here would have
    /// Jellyfin rewrite each materialized NFO from its own view of an item it derived from that
    /// same NFO, on every pass, drifting a little each time. The cost is that a hand-edit to a
    /// local film that happens to have a sidecar is no longer written back to it, which is
    /// invisible on a stock node because nothing writes NFOs beside local files.
    /// </para>
    /// <para>
    /// <b><c>LocalMetadataReaderOrder</c> puts the NFO reader first.</b> That is an ordering and
    /// never a filter, so it costs local files nothing and makes a peer's sidecar authoritative.
    /// </para>
    /// <para>
    /// Realtime monitoring stays <em>on</em>, so a film copied into the Movies folder by hand still
    /// appears. It now also watches the federated tree, which the materializer writes to
    /// constantly; <see cref="FederatedLibraryService"/> suppresses that with
    /// <c>ILibraryMonitor.ReportFileSystemChangeBeginning</c> for the duration of a pass, rather
    /// than by turning the watcher off for everybody.
    /// </para>
    /// </remarks>
    public static LibraryOptions BuildOptions(params string[] paths) => new()
    {
        PathInfos = (paths ?? Array.Empty<string>()).Select(p => new MediaPathInfo(p)).ToArray(),
        EnableRealtimeMonitor = true,
        SaveLocalMetadata = false,
        MetadataSavers = Array.Empty<string>(),
        // "Nfo" is the name every reader in MediaBrowser.XbmcMetadata reports (BaseNfoSaver
        // .SaverName). The comparison upstream is ordinal: "nfo" would match nothing.
        LocalMetadataReaderOrder = new[] { "Nfo" },
        // Episodes of one series held by different peers -- and a peer's series beside the local
        // one -- have to land under a single series.
        EnableAutomaticSeriesGrouping = true,
        // Already the defaults; pinned because any of them would hand ffmpeg a stingstream.local
        // URL it cannot resolve, once per pointer.
        EnableChapterImageExtraction = false,
        ExtractChapterImagesDuringLibraryScan = false,
        EnableTrickplayImageExtraction = false,
        ExtractTrickplayImagesDuringLibraryScan = false,
        EnableLUFSScan = false,
        // Left empty on purpose. See the remarks.
        TypeOptions = Array.Empty<TypeOptions>(),
    };

    /// <summary>Options for a library of nothing but pointers, which never touches the internet.</summary>
    /// <param name="path">The physical folder.</param>
    /// <returns>The options.</returns>
    /// <remarks>
    /// Only <c>Recordings</c> uses these now. It has no local counterpart, so the older and
    /// stricter arrangement still applies: an explicit <c>TypeOptions</c> entry per type is an
    /// empty allow-list, and cuts the library off from remote metadata <em>and</em> remote images,
    /// which <c>lockdata</c> alone does not do. That matters most here — a recording carries no
    /// provider ids, so a name-and-year lookup would confidently match it to the wrong thing.
    /// </remarks>
    public static LibraryOptions BuildFederatedOnlyOptions(string path) => new()
    {
        PathInfos = new[] { new MediaPathInfo(path) },
        EnableRealtimeMonitor = false,
        SaveLocalMetadata = false,
        MetadataSavers = Array.Empty<string>(),
        LocalMetadataReaderOrder = new[] { "Nfo" },
        DisabledSubtitleFetchers = Array.Empty<string>(),
        SubtitleFetcherOrder = Array.Empty<string>(),
        EnableAutomaticSeriesGrouping = true,
        EnableChapterImageExtraction = false,
        ExtractChapterImagesDuringLibraryScan = false,
        EnableTrickplayImageExtraction = false,
        ExtractTrickplayImagesDuringLibraryScan = false,
        EnableLUFSScan = false,
        TypeOptions = new[]
        {
            "Movie", "Series", "Season", "Episode", "Video", "BoxSet",
        }.Select(t => new TypeOptions { Type = t }).ToArray(),
    };

    /// <summary>Whether two paths name the same folder.</summary>
    /// <param name="a">One path.</param>
    /// <param name="b">The other.</param>
    /// <returns>True when they do.</returns>
    public static bool SamePath(string? a, string? b)
    {
        if (string.IsNullOrWhiteSpace(a) || string.IsNullOrWhiteSpace(b))
        {
            return false;
        }

        static string Norm(string s) => s.Replace('\\', '/').TrimEnd('/');
        return string.Equals(Norm(a), Norm(b), StringComparison.OrdinalIgnoreCase);
    }

    private async Task EnsureOneAsync(
        string name,
        CollectionTypeOptions collectionType,
        IReadOnlyList<string> paths,
        bool unified,
        LayoutReport report,
        CancellationToken cancellationToken)
    {
        if (paths.Count == 0)
        {
            report.Steps.Add($"library {name}: skipped (no path)");
            return;
        }

        foreach (var path in paths)
        {
            // AddVirtualFolder and AddMediaPath both throw on a path that does not exist, and on a
            // fresh node neither the media tree nor the federated one has been written to yet.
            Directory.CreateDirectory(path);
        }

        try
        {
            var folder = Find(name, paths);
            if (folder is null)
            {
                var options = unified
                    ? BuildOptions(paths.ToArray())
                    : BuildFederatedOnlyOptions(paths[0]);
                await _library.AddVirtualFolder(name, collectionType, options, refreshLibrary: false)
                    .ConfigureAwait(false);
                report.Created.Add(name);
                report.Steps.Add($"library {name}: created at {string.Join(", ", paths)}");
                _logger.LogInformation(
                    "Created the {Name} library at {Paths}",
                    name,
                    string.Join(", ", paths));
                return;
            }

            var added = new List<string>();
            foreach (var path in paths)
            {
                if (folder.Locations?.Any(l => SamePath(l, path)) == true)
                {
                    continue;
                }

                // The *directory* name, which is what AddMediaPath takes -- it is only ever the
                // display name by coincidence.
                _library.AddMediaPath(folder.Name, new MediaPathInfo(path));
                added.Add(path);
            }

            if (added.Count > 0)
            {
                report.Steps.Add($"library {name}: added {string.Join(", ", added)}");
                _logger.LogInformation(
                    "Added {Paths} to the {Name} library",
                    string.Join(", ", added),
                    name);
            }
            else
            {
                report.Steps.Add($"library {name}: already correct");
            }

            if (unified)
            {
                ApplyOptions(name, report);
            }
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or ArgumentException)
        {
            _logger.LogError(ex, "Could not set up the {Name} library", name);
            report.Steps.Add($"library {name}: failed ({ex.Message})");
            report.Ok = false;
        }

        cancellationToken.ThrowIfCancellationRequested();
    }

    /// <summary>
    /// Bring an existing library's options up to <see cref="BuildOptions"/>, if they are not already.
    /// </summary>
    /// <remarks>
    /// Only when they differ. Saving raises <c>LibraryOptionsUpdated</c>, and a node that wrote its
    /// options on every start would raise that event on every start for no change at all.
    /// <c>PathInfos</c> is carried over from what is on disk rather than from the wanted list,
    /// because <see cref="ILibraryManager.AddMediaPath"/> has already written it and somebody may
    /// have added a folder of their own.
    /// </remarks>
    private void ApplyOptions(string name, LayoutReport report)
    {
        var folder = _library.GetVirtualFolders()
            .FirstOrDefault(f => string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase));
        if (folder?.ItemId is null || !Guid.TryParse(folder.ItemId, out var id))
        {
            return;
        }

        if (_library.GetItemById(id) is not CollectionFolder collection)
        {
            return;
        }

        var current = collection.GetLibraryOptions();
        var wanted = BuildOptions();
        wanted.PathInfos = current.PathInfos;
        if (Matches(current, wanted))
        {
            return;
        }

        collection.UpdateLibraryOptions(wanted);
        report.Steps.Add($"library {name}: options updated");
        _logger.LogInformation("Updated the {Name} library's options", name);
    }

    private static bool Matches(LibraryOptions a, LibraryOptions b)
        => a.EnableRealtimeMonitor == b.EnableRealtimeMonitor
           && a.SaveLocalMetadata == b.SaveLocalMetadata
           && a.EnableAutomaticSeriesGrouping == b.EnableAutomaticSeriesGrouping
           && a.EnableChapterImageExtraction == b.EnableChapterImageExtraction
           && a.ExtractChapterImagesDuringLibraryScan == b.ExtractChapterImagesDuringLibraryScan
           && a.EnableTrickplayImageExtraction == b.EnableTrickplayImageExtraction
           && a.ExtractTrickplayImagesDuringLibraryScan == b.ExtractTrickplayImagesDuringLibraryScan
           && a.EnableLUFSScan == b.EnableLUFSScan
           && (a.MetadataSavers?.Length ?? -1) == (b.MetadataSavers?.Length ?? -1)
           && (a.TypeOptions?.Length ?? -1) == (b.TypeOptions?.Length ?? -1)
           && (a.LocalMetadataReaderOrder ?? Array.Empty<string>())
               .SequenceEqual(b.LocalMetadataReaderOrder ?? Array.Empty<string>(), StringComparer.Ordinal);

    /// <summary>The virtual folder for a library, by name or by any path it already holds.</summary>
    /// <remarks>
    /// By path as well as by name because somebody may have renamed the library, and creating a
    /// second one over the same folder is how a node ends up with both "Movies" and "Movies2".
    /// </remarks>
    private VirtualFolderInfo? Find(string name, IReadOnlyList<string> paths)
        => _library.GetVirtualFolders()
            .FirstOrDefault(f =>
                string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase)
                || (f.Locations?.Any(l => paths.Any(p => SamePath(l, p))) ?? false));

    private RootFolderSettings? RootFolders()
    {
        try
        {
            return _settings.Get().RootFolders;
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            // core.db is not ready. The supervisor's paths are the right answer on a fresh node
            // anyway, which is the only time that happens.
            _logger.LogDebug(ex, "Could not read the root folder settings; using the supervisor's paths");
            return null;
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

    private static string Coalesce(string? preferred, string? fallback)
        => !string.IsNullOrWhiteSpace(preferred) ? preferred : fallback ?? string.Empty;

    private static IReadOnlyList<string> Paths(params string?[] candidates)
        => candidates.Where(p => !string.IsNullOrWhiteSpace(p)).Select(p => p!).ToList();
}

/// <summary>What one <see cref="LibraryLayoutService.EnsureAsync"/> call did.</summary>
public sealed class LayoutReport
{
    /// <summary>Whether everything it tried succeeded.</summary>
    public bool Ok { get; set; } = true;

    /// <summary>Libraries created on this call.</summary>
    public List<string> Created { get; } = new();

    /// <summary>Human-readable lines for the first-run report.</summary>
    public List<string> Steps { get; } = new();
}
