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
/// The libraries come from <see cref="SharedSettings.Libraries"/>, which always holds <c>Movies</c>
/// and <c>TV Shows</c>: built in, never renamed, never removed, because titles arriving from other
/// servers merge into the local library of the same name. Each may hold several folders of this
/// node's own, and exactly one library per type also holds the <c>.strm</c> pointers
/// <see cref="FederatedLibraryService"/> materializes at its peers' files. There is no "Shared
/// Movies". Somebody who installed StingStream has one library of films, and whose disk a
/// particular film sits on is this program's problem rather than theirs.
/// </para>
/// <para>
/// A second drive is therefore a second <em>folder</em> on <c>Movies</c>, never a second
/// Movies-typed library: only the library holding the pointer tree merges with peers, so an extra
/// one would receive neither their titles nor new imports. <see cref="LibraryLayoutPlan"/> is where
/// that invariant is enforced and explained.
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
    private readonly ILibraryMonitor _monitor;
    private readonly INodeRuntimeProvider _runtime;
    private readonly SettingsStore _settings;
    private readonly ILogger<LibraryLayoutService> _logger;

    /// <summary>
    /// Whether this pass learned something the settings did not already record, and so is worth a
    /// write.
    /// </summary>
    /// <remarks>
    /// Guarded rather than unconditional because <see cref="SettingsStore.SaveAsync"/> bumps the
    /// revision, and the materializer decides whether to re-run this service by comparing that
    /// revision. Saving on every pass would therefore make every pass look like a change and this
    /// service would re-run itself forever.
    /// </remarks>
    private bool _settingsDirty;

    public LibraryLayoutService(
        ILibraryManager library,
        ILibraryMonitor monitor,
        INodeRuntimeProvider runtime,
        SettingsStore settings,
        ILogger<LibraryLayoutService> logger)
    {
        _library = library;
        _monitor = monitor;
        _runtime = runtime;
        _settings = settings;
        _logger = logger;
    }

    /// <summary>Create or repair every library this node should have. Safe to call on every start.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>What it did, for the first-run report.</returns>
    /// <remarks>
    /// Derived entirely from <see cref="SharedSettings.Libraries"/> plus the derived Recordings
    /// row, so it is both idempotent and the thing that makes a folder edit take effect: a path
    /// that moved is added in its new place and removed from its old one, which is the half that
    /// used not to happen at all.
    /// </remarks>
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

        var settings = Settings();
        if (settings is null)
        {
            report.Steps.Add("libraries: skipped (settings unavailable)");
            return report;
        }

        var removedSomething = false;
        foreach (var desired in LibraryLayoutPlan.Plan(settings, runtime?.Paths, federatedRoot))
        {
            var library = settings.Libraries.FirstOrDefault(
                l => string.Equals(l.FolderName, desired.FolderName, StringComparison.OrdinalIgnoreCase));

            removedSomething |= await EnsureOneAsync(desired, library, report, cancellationToken)
                .ConfigureAwait(false);
        }

        // Switched-off libraries, after the switched-on ones. Order matters on the day somebody
        // turns one library off and another of the same type on in a single edit: the federated
        // tree is added to its new host first, so it is never briefly attached to nothing.
        foreach (var library in settings.Libraries.Where(l => !l.Enabled))
        {
            removedSomething |= await WithdrawAsync(library, report).ConfigureAwait(false);
        }

        // Once per call, and only when the shape of what is on disk actually changed.
        // `ValidateMediaLibrary` cancels a scan that is already running, so doing it per library
        // would starve the scan on a node with several, and doing it on every start would cancel a
        // scan for no reason at all -- which is what "reconcile on every start" would mean.
        //
        // **Creating counts, and leaving it out was a first-install bug.** On a fresh node the
        // media scan runs before this does: Jellyfin scans at startup, these libraries are created
        // a few seconds later, and nothing scanned them afterwards. A film sitting in the media
        // folder before the node was ever started therefore stayed invisible until some scheduled
        // task happened along -- `e2e-m6` timed out at 420s waiting for exactly that, with one
        // "Scan Media Library Completed" in the whole run, five seconds before the libraries it
        // did not know about. Creation happens once per library, so this does not re-fire.
        if (removedSomething || report.Created.Count > 0)
        {
            await _library.ValidateMediaLibrary(new Progress<double>(), CancellationToken.None)
                .ConfigureAwait(false);
            report.Steps.Add(
                report.Created.Count > 0
                    ? "libraries: rescan queued (a library was created)"
                    : "libraries: rescan queued (a folder was removed)");
        }

        // The settings now carry the folder names and ids Jellyfin actually used, plus the
        // locations this node is responsible for. Persisting that is what lets the next run tell
        // its own work from somebody's hand edit.
        if (_settingsDirty)
        {
            _settingsDirty = false;
            await _settings.SaveAsync(settings, cancellationToken).ConfigureAwait(false);
        }

        return report;
    }

    /// <summary>Take a switched-off library out of the media server's view, keeping its files.</summary>
    /// <param name="library">The settings row that is off.</param>
    /// <param name="report">The first-run report to append to.</param>
    /// <returns><c>true</c> when a library was withdrawn, so the caller queues one rescan.</returns>
    /// <remarks>
    /// <para>
    /// <b>Nothing on disk is touched.</b> <c>RemoveVirtualFolder</c> deletes the virtual folder's
    /// shortcuts and its options file; the media stays exactly where it is, and so does anything a
    /// peer materialized into the federated tree beside it.
    /// </para>
    /// <para>
    /// The stored <c>JellyfinItemId</c> and <c>ManagedLocations</c> are cleared with it, because
    /// they describe a folder that no longer exists and would otherwise send <c>Find</c> chasing a
    /// dead id on the way back on. Re-adding the same paths gives the items their old ids back —
    /// Jellyfin derives an item id from its path — so watched state and resume positions survive a
    /// round trip through off.
    /// </para>
    /// </remarks>
    private async Task<bool> WithdrawAsync(LibrarySettings library, LayoutReport report)
    {
        var folder = _library.GetVirtualFolders().FirstOrDefault(
            f => (!string.IsNullOrWhiteSpace(library.JellyfinItemId)
                  && string.Equals(f.ItemId, library.JellyfinItemId, StringComparison.OrdinalIgnoreCase))
                 || string.Equals(f.Name, library.FolderName, StringComparison.OrdinalIgnoreCase));

        if (folder is null)
        {
            return false;
        }

        try
        {
            await _library.RemoveVirtualFolder(folder.Name, refreshLibrary: false).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // A library that will not come out is not a reason to fail the whole start: everything
            // else about "off" — the manager stopped, no new pointers written — still holds.
            _logger.LogWarning(ex, "Could not withdraw the {Name} library", library.Name);
            report.Steps.Add($"library {library.Name}: could not be switched off ({ex.Message})");
            return false;
        }

        library.JellyfinItemId = string.Empty;
        library.ManagedLocations = new List<string>();
        _settingsDirty = true;

        report.Steps.Add($"library {library.Name}: switched off (files kept)");
        _logger.LogInformation("Withdrew the {Name} library; its files were left in place", library.Name);
        return true;
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

    /// <summary>Create or repair one library, bringing its folders in line with the plan.</summary>
    /// <param name="desired">What it should be.</param>
    /// <param name="stored">Its settings row, when it has one. Recordings is derived and has none.</param>
    /// <param name="report">Accumulates what happened.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns><c>true</c> when a location was removed, so the caller can queue one rescan.</returns>
    /// <remarks>
    /// <para>
    /// <b>Add before remove, always.</b> If an add throws, on a path that cannot be created or
    /// written, nothing has been taken away and the library is exactly as it was; the reader gets
    /// an error and no damage. The other order has a window in which the library holds no local
    /// folder at all, and a scan landing in that window empties it.
    /// </para>
    /// <para>
    /// Nothing here deletes media. <c>RemoveMediaPath</c> rewrites the virtual folder's shortcuts
    /// and its options file; the files stay on disk, and the items linger in the database until the
    /// queued rescan prunes them.
    /// </para>
    /// </remarks>
    private async Task<bool> EnsureOneAsync(
        DesiredLibrary desired,
        LibrarySettings? stored,
        LayoutReport report,
        CancellationToken cancellationToken)
    {
        if (desired.Paths.Count == 0)
        {
            report.Steps.Add($"library {desired.Name}: skipped (no path)");
            return false;
        }

        foreach (var path in desired.Paths)
        {
            // AddVirtualFolder and AddMediaPath both throw on a path that does not exist, and on a
            // fresh node neither the media tree nor the federated one has been written to yet.
            Directory.CreateDirectory(path);
        }

        var removed = false;

        try
        {
            var folder = Find(desired, stored);
            if (folder is null)
            {
                var options = desired.Unified
                    ? BuildOptions(desired.Paths.ToArray())
                    : BuildFederatedOnlyOptions(desired.Paths[0]);

                await _library.AddVirtualFolder(desired.Name, desired.Type, options, refreshLibrary: false)
                    .ConfigureAwait(false);

                // Read back rather than assume. AddVirtualFolder runs the name through
                // GetValidFilename and appends a digit on collision, so "TV Shows" can land as
                // "TV Shows2" -- and AddMediaPath keys on that directory name, not on the display
                // name, so guessing it wrong strands every later edit.
                Adopt(desired, stored, desired.Paths);

                report.Created.Add(desired.Name);
                report.Steps.Add($"library {desired.Name}: created at {string.Join(", ", desired.Paths)}");
                _logger.LogInformation(
                    "Created the {Name} library at {Paths}",
                    desired.Name,
                    string.Join(", ", desired.Paths));
                return false;
            }

            var (toAdd, toRemove) = LibraryLayoutPlan.Diff(
                folder.Locations,
                stored?.ManagedLocations,
                desired.Paths);

            if (toAdd.Count == 0 && toRemove.Count == 0)
            {
                // The every-start no-op. Reconciliation runs on every boot now, so this comparison
                // is the thing standing between that and a pile of pointless library events.
                report.Steps.Add($"library {desired.Name}: already correct");
                Adopt(desired, stored, desired.Paths);
                if (desired.Unified)
                {
                    ApplyOptions(folder.Name, report);
                }

                return false;
            }

            // Upstream stops the watcher around exactly these calls; a file event fired against a
            // library mid-rewire is read against a location that is on its way in or out.
            _monitor.Stop();
            try
            {
                foreach (var path in toAdd)
                {
                    _library.AddMediaPath(folder.Name, new MediaPathInfo(path));
                }

                foreach (var path in toRemove)
                {
                    _library.RemoveMediaPath(folder.Name, path);
                    removed = true;
                }
            }
            finally
            {
                _monitor.Start();
            }

            if (toAdd.Count > 0)
            {
                report.Steps.Add($"library {desired.Name}: added {string.Join(", ", toAdd)}");
                _logger.LogInformation(
                    "Added {Paths} to the {Name} library",
                    string.Join(", ", toAdd),
                    desired.Name);
            }

            if (toRemove.Count > 0)
            {
                report.Steps.Add($"library {desired.Name}: removed {string.Join(", ", toRemove)}");
                _logger.LogInformation(
                    "Removed {Paths} from the {Name} library",
                    string.Join(", ", toRemove),
                    desired.Name);
            }

            Adopt(desired, stored, desired.Paths);

            if (desired.Unified)
            {
                ApplyOptions(folder.Name, report);
            }
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or ArgumentException)
        {
            _logger.LogError(ex, "Could not set up the {Name} library", desired.Name);
            report.Steps.Add($"library {desired.Name}: failed ({ex.Message})");
            report.Ok = false;
        }

        cancellationToken.ThrowIfCancellationRequested();
        return removed;
    }

    /// <summary>
    /// Record on the settings row what Jellyfin actually called this library and which locations
    /// this node is now responsible for.
    /// </summary>
    /// <remarks>
    /// <see cref="LibraryLayoutPlan.Diff"/> only ever removes a location it finds in
    /// <see cref="LibrarySettings.ManagedLocations"/>, so this is what draws the line between "we
    /// put it there" and "somebody added it by hand". Getting it wrong in one direction reverts a
    /// person's edit on the next boot; in the other, it strands an old folder forever.
    /// </remarks>
    private void Adopt(DesiredLibrary desired, LibrarySettings? stored, IReadOnlyList<string> paths)
    {
        if (stored is null)
        {
            return;
        }

        var folder = _library.GetVirtualFolders()
            .FirstOrDefault(f => string.Equals(f.Name, desired.FolderName, StringComparison.OrdinalIgnoreCase))
            ?? _library.GetVirtualFolders()
                .FirstOrDefault(f => f.Locations?.Any(l => paths.Any(p => SamePath(l, p))) ?? false);

        var folderName = folder?.Name ?? desired.FolderName;
        var itemId = folder?.ItemId ?? string.Empty;

        if (!string.Equals(stored.FolderName, folderName, StringComparison.Ordinal))
        {
            stored.FolderName = folderName;
            _settingsDirty = true;
        }

        if (!string.IsNullOrWhiteSpace(itemId) && !string.Equals(stored.JellyfinItemId, itemId, StringComparison.Ordinal))
        {
            stored.JellyfinItemId = itemId;
            _settingsDirty = true;
        }

        if (!stored.ManagedLocations.SequenceEqual(paths, StringComparer.OrdinalIgnoreCase))
        {
            stored.ManagedLocations = paths.ToList();
            _settingsDirty = true;
        }
    }

    /// <summary>The virtual folder for a library.</summary>
    /// <remarks>
    /// <para>
    /// Identity first, name second, and <b>no path fallback</b>. Matching on "holds one of these
    /// paths" was safe while there were exactly three fixed libraries and is actively wrong now
    /// that a reader can have several: a library whose folder was just changed still holds the old
    /// path, so a path match would find the wrong library and rewire it.
    /// </para>
    /// <para>
    /// A library created before this node started recording ids has neither, and is found by the
    /// name it was created under, which is also the name the migration seeded.
    /// </para>
    /// </remarks>
    private VirtualFolderInfo? Find(DesiredLibrary desired, LibrarySettings? stored)
    {
        var folders = _library.GetVirtualFolders();

        if (!string.IsNullOrWhiteSpace(stored?.JellyfinItemId))
        {
            var byId = folders.FirstOrDefault(
                f => string.Equals(f.ItemId, stored.JellyfinItemId, StringComparison.OrdinalIgnoreCase));
            if (byId is not null)
            {
                return byId;
            }
        }

        return folders.FirstOrDefault(
            f => string.Equals(f.Name, desired.FolderName, StringComparison.OrdinalIgnoreCase));
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


    private SharedSettings? Settings()
    {
        try
        {
            return _settings.Get();
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            // core.db is not ready, which on a fresh node is the only time this happens.
            _logger.LogDebug(ex, "Could not read the library settings");
            return null;
        }
    }

    /// <summary>Where peers' pointers are materialized, for a caller validating a folder against it.</summary>
    /// <returns>The federated root, or <c>null</c> on a Jellyfin with no supervisor.</returns>
    public string? FederatedRootPath() => FederatedRoot();

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
