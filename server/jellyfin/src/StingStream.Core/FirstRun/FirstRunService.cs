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
    private readonly System.Net.Http.IHttpClientFactory _httpFactory;
    private readonly ArrClientFactory _arrs;
    private readonly MediaBrowser.Common.Updates.IInstallationManager _installs;
    private readonly MediaBrowser.Common.Plugins.IPluginManager _plugins;

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
        IInventoryService inventory,
        System.Net.Http.IHttpClientFactory httpFactory,
        ArrClientFactory arrs,
        MediaBrowser.Common.Updates.IInstallationManager installs,
        MediaBrowser.Common.Plugins.IPluginManager plugins)
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
        _httpFactory = httpFactory;
        _arrs = arrs;
        _installs = installs;
        _plugins = plugins;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Wait for this server's own HTTP surface, not a fixed delay.
        //
        // Hosted services start before Kestrel accepts connections, and the first thing the wiring
        // does is register a download client pointing at the qBittorrent shim *in this process*.
        // Registering it while nothing is listening had Radarr reject the whole request with
        // "Host: Unable to connect to qBittorrent" and take first-run wiring down with it. A flat
        // five-second delay was enough on a developer's machine and not on a CI runner, which is
        // exactly the kind of guess this replaces.
        await WaitForSelfAsync(stoppingToken).ConfigureAwait(false);

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

    /// <summary>
    /// Wait until this server answers its own health endpoint, or the timeout elapses.
    /// </summary>
    private async Task WaitForSelfAsync(CancellationToken cancellationToken)
    {
        var jellyfin = _arrs.Jellyfin;
        if (jellyfin is null)
        {
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken).ConfigureAwait(false);
            return;
        }

        var url = jellyfin.BaseUrl + "/health";
        using var http = _httpFactory.CreateClient(ArrClient.HttpClientName);
        http.Timeout = TimeSpan.FromSeconds(5);

        var deadline = DateTime.UtcNow.AddMinutes(3);
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                using var response = await http.GetAsync(url, cancellationToken).ConfigureAwait(false);
                if (response.IsSuccessStatusCode)
                {
                    _logger.LogDebug("This server is answering at {Url}; starting wiring", url);
                    return;
                }
            }
            catch (Exception ex) when (ex is System.Net.Http.HttpRequestException or TaskCanceledException)
            {
                // Not listening yet.
            }

            await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken).ConfigureAwait(false);
        }

        _logger.LogWarning("This server never answered {Url}; wiring anyway", url);
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

        if (firstRun)
        {
            // First, before anything that talks to another process. Two reasons, and both were
            // learned rather than guessed. The account is what somebody at the keyboard is
            // actually waiting for, and the arr sync below can take a minute on a fresh node while
            // Radarr and Sonarr migrate their databases. And until this step runs there is no
            // account and no pending flag, which is a window in which the setup endpoint has to
            // answer "still pending" from `runtime.json`'s first_run rather than from a flag that
            // does not exist yet -- see SetupController.ResolvePendingAsync. Shrinking that window
            // to nothing is cheaper than relying on the fallback being right.
            await EnsureAdminUserAsync(runtime, report, cancellationToken).ConfigureAwait(false);
        }

        await EnsureSharedSettingsAsync(runtime, report, cancellationToken).ConfigureAwait(false);
        // Every start, not only the first: it checks whether the plugin is *there* rather than
        // whether it has run, so an install that failed for want of a network repairs itself.
        await EnsureSubtitlesAsync(report, cancellationToken).ConfigureAwait(false);
        await EnsureTorrentCategoriesAsync(report, cancellationToken).ConfigureAwait(false);
        await SyncArrsAsync(report, cancellationToken).ConfigureAwait(false);

        if (!firstRun)
        {
            report.Steps.Add("already wired: refreshed the arrs' view of this run's ports only");
            return report;
        }

        // Genuinely once-only, like the administrator above: creating a library a second time
        // would be wrong, not merely wasteful.
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

    // --- the node's administrator ------------------------------------------

    /// <summary>
    /// Have exactly one administrator, and know whether anybody has claimed it yet.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The bootstrap account starts life named and passworded from <c>runtime.json</c>, so a node
    /// is usable the moment it is up. What decides whether this method may touch that account
    /// again is <see cref="FirstRunSetupState"/>, not the number of accounts: once somebody has
    /// been through the first-run screen there is still exactly one account, and it has the name
    /// and the password <em>they</em> chose. Re-applying <c>runtime.json</c> over the top of that
    /// would silently take their node away from them on the next wiring pass, which is precisely
    /// what <c>POST /stingstream/api/v1/setup/run</c> invites somebody to do.
    /// </para>
    /// <para>
    /// It also has to survive <c>runtime.json</c> losing the password entirely: the supervisor
    /// scrubs it once setup is complete, because a plaintext administrator password sitting under
    /// <c>%ProgramData%</c> for the life of the install is the one standing credential exposure
    /// this design had (<c>docs/SECURITY.md</c> R1). Nothing else in this process authenticates
    /// with it — the arrs hold their own API keys, the download clients their own credentials, the
    /// webhook its own token, and the library, inventory and plugin work is all in-process — so
    /// once setup is done its absence changes nothing.
    /// </para>
    /// </remarks>
    private async Task EnsureAdminUserAsync(
        NodeRuntime runtime,
        FirstRunReport report,
        CancellationToken cancellationToken)
    {
        var desired = runtime.JellyfinAdmin;

        try
        {
            // Counted either side of InitializeAsync, which is idempotent -- it returns
            // immediately when any user exists and otherwise creates one administrator. The
            // difference is the only honest answer to "did *we* just create the bootstrap
            // account", which is what sets the pending flag, and getting it this way means not
            // reaching past IUserManager into the database.
            var before = _users.GetUsers().Count();
            await _users.InitializeAsync().ConfigureAwait(false);

            var existingCount = _users.GetUsers().Count();
            var created = before == 0 && existingCount > 0;
            var first = _users.GetFirstUser();
            if (first is null)
            {
                report.Steps.Add("admin user: no account exists and one could not be created");
                report.Ok = false;
                return;
            }

            var stored = _settings.GetDocument<FirstRunSetupState>(FirstRunSetupState.StorageKey);
            bool pending;
            if (created)
            {
                // We made it and nobody has seen it: the first-run screen has an account to hand
                // over.
                pending = true;
            }
            else if (stored is not null)
            {
                pending = stored.Pending;
            }
            else
            {
                // A node wired by a build that predates the flag. Somebody is already using the
                // account that is there, and "no record" must never be read as "up for grabs".
                pending = false;
            }

            if (stored is null || stored.Pending != pending)
            {
                await FirstRunSetupState.SetAsync(_settings, pending, cancellationToken).ConfigureAwait(false);
            }

            // Note that more than one account is a reason not to *touch* the account, and not a
            // reason to close setup. Only a successful setup/admin does that -- see
            // SetupController.ResolvePending for what went wrong when anything else did.
            if (!pending || existingCount > 1)
            {
                report.Steps.Add(
                    existingCount > 1
                        ? $"admin user: left alone ({existingCount} accounts already exist)"
                        : "admin user: left alone (this node's account has already been claimed)");
            }
            else if (desired is null || string.IsNullOrWhiteSpace(desired.Username))
            {
                report.Steps.Add("admin user: waiting to be claimed (runtime.json names no account)");
            }
            else
            {
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
                else if (created)
                {
                    // We just made the account and have nothing to set on it, so it is sitting
                    // there with whatever the server's own bootstrap gave it -- which nobody
                    // knows. Recoverable (the first-run screen claims it), but it means the
                    // supervisor scrubbed the generated password before this ran, and that is
                    // worth naming: it is the difference between "waiting to be claimed" and
                    // "nothing can sign in", and it cost an acceptance run once.
                    _logger.LogWarning(
                        "Created the bootstrap account with no password: runtime.json no longer "
                        + "holds one. Finish setup from the machine running this node.");
                    report.Steps.Add(
                        "admin user: created with no password (runtime.json holds none); claim it "
                        + "from the first-run screen");
                }
                else
                {
                    // The supervisor has scrubbed it. Nothing in this process needs it, and the
                    // account keeps whatever it was last set to, so this is a note and not a
                    // problem.
                    report.Steps.Add("admin user: runtime.json holds no password; keeping the current one");
                }

                report.Steps.Add("admin user: waiting for the first-run screen to claim it");
            }

            // The supervisor already wrote IsStartupWizardCompleted into system.xml; assert it
            // here too so a node whose config was reset does not fall back into the wizard, which
            // would leave the API anonymously accessible.
            if (!_serverConfig.Configuration.IsStartupWizardCompleted)
            {
                _serverConfig.Configuration.IsStartupWizardCompleted = true;
                _serverConfig.SaveConfiguration();
                report.Steps.Add("marked the startup wizard complete");
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentException)
        {
            _logger.LogError(ex, "Could not set up this node's administrator account");
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

    // --- subtitles ---------------------------------------------------------

    /// <summary>The OpenSubtitles plugin's own id, from its manifest.</summary>
    /// <remarks>
    /// Hard-coded because it is what identifies the plugin: names change with translations and
    /// with whoever writes the manifest entry, and matching on one would install something else the
    /// day somebody renames it. The value is the plugin's <c>Guid</c> in Jellyfin's own repository
    /// manifest and has not changed since the plugin was split out of the server.
    /// </remarks>
    public static readonly Guid OpenSubtitlesPluginId = new("4b9ed42f-5185-48b5-9803-6ff2989014c4");

    /// <summary>Jellyfin's own plugin repository. Where OpenSubtitles comes from.</summary>
    public const string JellyfinPluginRepository = "https://repo.jellyfin.org/files/plugin/manifest.json";

    /// <summary>
    /// Have the OpenSubtitles plugin installed, so subtitles work out of the box.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Jellyfin ships with *no* subtitle provider at all — `ISubtitleManager` is there, and finds
    /// nothing, and a user's first experience of subtitles is a search that returns an empty list
    /// with no explanation. Installing the one everybody installs anyway is the difference between
    /// a feature and a support question.
    /// </para>
    /// <para>
    /// **No credentials are set here, and none are committed.** The plugin works anonymously with a
    /// small daily download quota; a registered account raises it, and a user adds theirs in the
    /// app under Server settings → Subtitles. Putting an account in the repository would be putting
    /// a shared secret in a public one — see `docs/ARCHITECTURE.md`, "Subtitles".
    /// </para>
    /// <para>
    /// Runs on **every** start rather than only the first, and is idempotent: it checks whether the
    /// plugin is present rather than whether it has run. A plugin the user deliberately removed
    /// comes back, which is the one wart here — and the alternative, remembering a flag, silently
    /// stops repairing an install where the download failed the first time.
    /// </para>
    /// </remarks>
    private async Task EnsureSubtitlesAsync(FirstRunReport report, CancellationToken cancellationToken)
    {
        var settings = _settings.Get();
        if (!settings.Subtitles.Enabled)
        {
            report.Steps.Add("subtitles: disabled in settings");
            return;
        }

        // Wanted languages, written down rather than left implicit, so what the group acts on is
        // visible in the settings API rather than being a fallback nobody can see.
        if (settings.Subtitles.Languages.Count == 0)
        {
            var language = Subtitles.SubtitleService.DefaultLanguage(_serverConfig.Configuration.UICulture);
            if (language is not null)
            {
                settings.Subtitles.Languages.Add(language);
                await _settings.SaveAsync(settings, cancellationToken).ConfigureAwait(false);
                report.Steps.Add(
                    $"subtitles: wanted languages default to {language} (this node's UI language)");
            }
        }

        // The repository. Present by default on a current Jellyfin, but a node whose configuration
        // came from somewhere else may not have it, and installing from a repository that is not
        // there fails in a way that reads as "the plugin does not exist".
        var config = _serverConfig.Configuration;
        var repositories = config.PluginRepositories.ToList();
        if (!repositories.Any(r => string.Equals(r.Url, JellyfinPluginRepository, StringComparison.OrdinalIgnoreCase)))
        {
            repositories.Add(new MediaBrowser.Model.Updates.RepositoryInfo
            {
                Name = "Jellyfin Stable",
                Url = JellyfinPluginRepository,
                Enabled = true,
            });
            config.PluginRepositories = repositories.ToArray();
            _serverConfig.SaveConfiguration();
            report.Steps.Add("subtitles: added Jellyfin's plugin repository");
        }

        if (_plugins.GetPlugin(OpenSubtitlesPluginId) is not null)
        {
            report.Steps.Add("subtitles: the OpenSubtitles plugin is installed");
            return;
        }

        try
        {
            var available = await _installs.GetAvailablePackages(cancellationToken).ConfigureAwait(false);
            var version = _installs
                .GetCompatibleVersions(available, id: OpenSubtitlesPluginId)
                .FirstOrDefault();
            if (version is null)
            {
                report.Steps.Add(
                    "subtitles: no compatible OpenSubtitles build in the repository (this node may "
                    + "have no route out); subtitles still work if you install it by hand");
                return;
            }

            await _installs.InstallPackage(version, cancellationToken).ConfigureAwait(false);
            report.Steps.Add(
                $"subtitles: installed OpenSubtitles {version.Version}. It loads on the next restart, "
                + "and works anonymously; add an account under Server settings -> Subtitles for a "
                + "larger daily quota.");
            _logger.LogInformation(
                "Installed the OpenSubtitles plugin ({Version}). It loads on the next restart.",
                version.Version);
        }
        catch (Exception ex) when (ex is System.Net.Http.HttpRequestException or InvalidOperationException
                                       or TaskCanceledException or IOException)
        {
            // A node with no route out is a perfectly good node. Say so and carry on -- this must
            // never be the reason first-run wiring reports a failure.
            _logger.LogInformation(ex, "Could not install the OpenSubtitles plugin");
            report.Steps.Add($"subtitles: could not install OpenSubtitles ({ex.Message})");
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
