using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StingStream.Core.Arr;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Inventory;
using StingStream.Core.Torrents;

namespace StingStream.Core.FirstRun;

/// <summary>
/// Wires a node together: fully the first time, and enough to keep it working on every start
/// after that.
/// </summary>
/// <remarks>
/// "One install, one command, and it works" is the whole promise of a StingStream node, and this
/// is where that promise is kept. On a fresh data directory it creates the Jellyfin administrator,
/// the Movies and TV Shows libraries, the qBittorrent categories the arrs will use, the arrs' root
/// folders, both download clients, the indexers, the naming rules and the import webhook.
///
/// On every subsequent start it re-runs the *configuration* half. That is not belt and braces: the
/// children's ports are assigned at start-up and can move between runs, and the arrs store their
/// download client's host and port, so a node that only wired itself once would come back from a
/// restart with both apps talking to dead ports. Creating an administrator or a library, by
/// contrast, is genuinely once-only.
///
/// The whole thing runs on a background task rather than blocking start-up: Radarr and Sonarr are
/// still starting when Jellyfin is ready, and the sync waits for them.
/// </remarks>
public sealed class FirstRunService : BackgroundService
{
    /// <summary>How long to wait for Radarr and Sonarr to come up before giving up on this pass.</summary>
    public static readonly TimeSpan ArrStartupTimeout = TimeSpan.FromMinutes(5);

    private readonly ILogger<FirstRunService> _logger;
    private readonly INodeRuntimeProvider _runtime;
    private readonly CoreDatabase _db;
    private readonly SettingsStore _settings;
    private readonly OmniarrSyncService _sync;
    private readonly TorrentEngine _torrents;
    private readonly ILibraryManager _library;
    private readonly IUserManager _users;
    private readonly IServerConfigurationManager _serverConfig;
    private readonly IInventoryService _inventory;

    public FirstRunService(
        ILogger<FirstRunService> logger,
        INodeRuntimeProvider runtime,
        CoreDatabase db,
        SettingsStore settings,
        OmniarrSyncService sync,
        TorrentEngine torrents,
        ILibraryManager library,
        IUserManager users,
        IServerConfigurationManager serverConfig,
        IInventoryService inventory)
    {
        _logger = logger;
        _runtime = runtime;
        _db = db;
        _settings = settings;
        _sync = sync;
        _torrents = torrents;
        _library = library;
        _users = users;
        _serverConfig = serverConfig;
        _inventory = inventory;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Let Jellyfin finish coming up. Creating libraries while its own start-up scan is still
        // running produces a scan that misses them.
        await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken).ConfigureAwait(false);

        try
        {
            await RunAsync(stoppingToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Shutting down mid-wiring. The first_run flag is still set, so the next start
            // picks up where this left off.
        }
        catch (Exception ex)
        {
            // Never let first-run wiring take Jellyfin down with it: a node that came up with a
            // half-configured Radarr is still a node someone can log into and fix.
            _logger.LogError(ex, "First-run wiring failed. The node is running; re-run it from /stingstream/api/v1/setup/run");
        }
    }

    /// <summary>Run the wiring. Public so the API can re-run it on demand.</summary>
    public async Task<FirstRunReport> RunAsync(CancellationToken cancellationToken, bool force = false)
    {
        var report = new FirstRunReport();
        var runtime = _runtime.Current;

        if (runtime is null)
        {
            report.Skipped = true;
            report.Steps.Add("skipped: no runtime.json (this server was not started by the supervisor)");
            _logger.LogInformation(
                "No runtime.json; skipping first-run wiring. Start this server through the StingStream supervisor.");
            return report;
        }

        var firstRun = runtime.FirstRun || force;
        _db.EnsureInitialized();

        // These run on *every* start, not just the first.
        //
        // The children's ports are assigned at start-up and can move between runs — a preferred
        // port that something else has taken falls back to an ephemeral one. The arrs store their
        // download client's host and port, so without a sync on every start a restart leaves both
        // apps pointing at dead ports, with nothing but "Unable to retrieve queue and history
        // items" in their logs and downloads that silently never import. Everything here is
        // idempotent and matched by name, so re-running it converges rather than duplicating.
        _logger.LogInformation(
            "{Phase} StingStream wiring for node {Node}",
            firstRun ? "Starting first-run" : "Refreshing",
            runtime.NodeName);

        await EnsureSharedSettingsAsync(runtime, report, cancellationToken).ConfigureAwait(false);
        await EnsureTorrentCategoriesAsync(report, cancellationToken).ConfigureAwait(false);
        await SyncArrsAsync(report, cancellationToken).ConfigureAwait(false);

        if (!firstRun)
        {
            report.Steps.Add("already wired: refreshed the arrs' view of this run's ports only");
            return report;
        }

        // These are genuinely once-only: creating an administrator or a library a second time
        // would be wrong, not merely wasteful.
        await EnsureAdminUserAsync(runtime, report).ConfigureAwait(false);
        await EnsureLibrariesAsync(runtime, report, cancellationToken).ConfigureAwait(false);

        // Build whatever the node already holds, so a re-wired node has an inventory immediately.
        try
        {
            var built = await _inventory.RebuildAllAsync(cancellationToken).ConfigureAwait(false);
            report.Steps.Add($"inventory: built {built} record(s)");
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException)
        {
            report.Steps.Add($"inventory: failed ({ex.Message})");
        }

        if (report.Ok)
        {
            _runtime.ClearFirstRun();
            report.Steps.Add("marked first_run complete in runtime.json");
            _logger.LogInformation("First-run wiring complete");
        }
        else
        {
            _logger.LogWarning(
                "First-run wiring finished with problems; leaving first_run set so the next start retries");
        }

        return report;
    }

    // --- Jellyfin administrator -------------------------------------------

    private async Task EnsureAdminUserAsync(NodeRuntime runtime, FirstRunReport report)
    {
        var desired = runtime.JellyfinAdmin;
        if (desired is null || string.IsNullOrWhiteSpace(desired.Username))
        {
            report.Steps.Add("admin user: skipped (runtime.json has no credentials)");
            return;
        }

        try
        {
            // InitializeAsync is idempotent: it returns immediately when any user exists, and
            // otherwise creates one administrator. That is exactly the "only if none exists"
            // condition, and using it means not reaching past IUserManager into the database.
            await _users.InitializeAsync().ConfigureAwait(false);

            var existingCount = _users.GetUsers().Count();
            var first = _users.GetFirstUser();
            if (first is null)
            {
                report.Steps.Add("admin user: no user exists and one could not be created");
                report.Ok = false;
                return;
            }

            if (existingCount > 1)
            {
                // Somebody has already set this node up properly. Renaming or repasswording an
                // account out from under them would be actively hostile.
                report.Steps.Add($"admin user: left alone ({existingCount} users already exist)");
                return;
            }

            if (!string.Equals(first.Username, desired.Username, StringComparison.OrdinalIgnoreCase))
            {
                await _users.RenameUser(first.Id, first.Username, desired.Username).ConfigureAwait(false);
                report.Steps.Add($"admin user: renamed the bootstrap account to {desired.Username}");
            }

            if (!string.IsNullOrEmpty(desired.Password))
            {
                await _users.ChangePassword(first.Id, desired.Password).ConfigureAwait(false);
                report.Steps.Add("admin user: password set from runtime.json");
            }

            // The supervisor already wrote IsStartupWizardCompleted into system.xml; assert it
            // here too so a node whose config was reset does not fall back into the wizard, which
            // would leave the API anonymously accessible.
            if (!_serverConfig.Configuration.IsStartupWizardCompleted)
            {
                _serverConfig.Configuration.IsStartupWizardCompleted = true;
                _serverConfig.SaveConfiguration();
                report.Steps.Add("marked the Jellyfin startup wizard complete");
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentException)
        {
            _logger.LogError(ex, "Could not set up the Jellyfin administrator");
            report.Steps.Add($"admin user: failed ({ex.Message})");
            report.Ok = false;
        }
    }

    // --- shared settings ---------------------------------------------------

    private async Task EnsureSharedSettingsAsync(
        NodeRuntime runtime,
        FirstRunReport report,
        CancellationToken cancellationToken)
    {
        var settings = _settings.Get();
        var changed = false;

        if (string.IsNullOrWhiteSpace(settings.RootFolders.Movies))
        {
            settings.RootFolders.Movies = runtime.Paths.MediaMovies;
            changed = true;
        }

        if (string.IsNullOrWhiteSpace(settings.RootFolders.Tv))
        {
            settings.RootFolders.Tv = runtime.Paths.MediaTv;
            changed = true;
        }

        if (changed)
        {
            await _settings.SaveAsync(settings, cancellationToken).ConfigureAwait(false);
            report.Steps.Add(
                $"settings: root folders default to {settings.RootFolders.Movies} and {settings.RootFolders.Tv}");
        }
    }

    // --- torrent categories ------------------------------------------------

    private async Task EnsureTorrentCategoriesAsync(FirstRunReport report, CancellationToken cancellationToken)
    {
        if (!_torrents.IsRunning)
        {
            report.Steps.Add("torrent categories: skipped (the engine is not running)");
            return;
        }

        var settings = _settings.Get();
        foreach (var category in new[]
                 {
                     settings.DownloadClients.TorrentMovieCategory,
                     settings.DownloadClients.TorrentTvCategory,
                 })
        {
            if (string.IsNullOrWhiteSpace(category))
            {
                continue;
            }

            // Creating these up front means the arrs' download-client Test passes on the very
            // first try, instead of creating the category and re-checking.
            await _torrents.CreateCategoryAsync(category, null, cancellationToken).ConfigureAwait(false);
        }

        report.Steps.Add(
            $"torrent categories: {settings.DownloadClients.TorrentMovieCategory}, "
            + $"{settings.DownloadClients.TorrentTvCategory} under {_torrents.Root}");
    }

    // --- Jellyfin libraries ------------------------------------------------

    private async Task EnsureLibrariesAsync(
        NodeRuntime runtime,
        FirstRunReport report,
        CancellationToken cancellationToken)
    {
        var settings = _settings.Get();
        var movies = Coalesce(settings.RootFolders.Movies, runtime.Paths.MediaMovies);
        var tv = Coalesce(settings.RootFolders.Tv, runtime.Paths.MediaTv);

        await EnsureLibraryAsync("Movies", CollectionTypeOptions.movies, movies, report, cancellationToken)
            .ConfigureAwait(false);
        await EnsureLibraryAsync("TV Shows", CollectionTypeOptions.tvshows, tv, report, cancellationToken)
            .ConfigureAwait(false);
    }

    private static string Coalesce(string? preferred, string? fallback)
        => !string.IsNullOrWhiteSpace(preferred) ? preferred : fallback ?? string.Empty;

    private async Task EnsureLibraryAsync(
        string name,
        CollectionTypeOptions collectionType,
        string path,
        FirstRunReport report,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            report.Steps.Add($"library {name}: skipped (no path)");
            return;
        }

        Directory.CreateDirectory(path);

        var existing = _library.GetVirtualFolders();
        var already = existing.FirstOrDefault(f =>
            string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase)
            || (f.Locations?.Any(l => PathsEqual(l, path)) ?? false));
        if (already is not null)
        {
            report.Steps.Add($"library {name}: already exists");
            return;
        }

        try
        {
            var options = new LibraryOptions
            {
                PathInfos = new[] { new MediaPathInfo(path) },
                EnableRealtimeMonitor = true,
                // Metadata comes from the arrs' own naming plus Jellyfin's providers, exactly as a
                // stock install would do it. The federated Shared libraries in M3 are the ones
                // that turn internet lookups off and read NFOs only.
                SaveLocalMetadata = false,
            };
            await _library.AddVirtualFolder(name, collectionType, options, refreshLibrary: true)
                .ConfigureAwait(false);
            report.Steps.Add($"library {name}: created at {path}");
            _logger.LogInformation("Created Jellyfin library {Name} at {Path}", name, path);
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or ArgumentException)
        {
            _logger.LogError(ex, "Could not create the {Name} library", name);
            report.Steps.Add($"library {name}: failed ({ex.Message})");
            report.Ok = false;
        }

        // AddVirtualFolder's own refresh is fire-and-forget; nothing to await here.
        await Task.CompletedTask.ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
    }

    private static bool PathsEqual(string? a, string? b)
    {
        if (a is null || b is null)
        {
            return false;
        }

        static string Norm(string s) => s.TrimEnd('/', '\\').Replace('\\', '/');
        return string.Equals(Norm(a), Norm(b), StringComparison.OrdinalIgnoreCase);
    }

    // --- arrs --------------------------------------------------------------

    private async Task SyncArrsAsync(FirstRunReport report, CancellationToken cancellationToken)
    {
        var results = await _sync.SyncAllAsync(ArrStartupTimeout, cancellationToken).ConfigureAwait(false);
        foreach (var result in results)
        {
            report.Steps.Add($"{result.App}: {result.Message}");
            foreach (var detail in result.Detail)
            {
                report.Steps.Add($"  {result.App} {detail}");
            }

            if (!result.Ok)
            {
                report.Ok = false;
            }
        }
    }
}

/// <summary>What first-run wiring did.</summary>
public sealed class FirstRunReport
{
    /// <summary>False when any step failed, which leaves <c>first_run</c> set for the next start.</summary>
    public bool Ok { get; set; } = true;

    /// <summary>True when there was nothing to do.</summary>
    public bool Skipped { get; set; }

    public List<string> Steps { get; } = new();
}
