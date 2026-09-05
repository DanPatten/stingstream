using System;
using System.Collections.Generic;
using System.Linq;

namespace StingStream.Core.Data;

/// <summary>
/// "Omniarr": the one settings model StingStream keeps, pushed idempotently into both Radarr and
/// Sonarr through their v3 APIs.
/// </summary>
/// <remarks>
/// The point of the merge is that a user configures indexers, download clients, root folders and
/// notifications once, in StingStream, and never opens a Radarr or Sonarr settings page. This
/// model is the shape of that single configuration; <see cref="Arr.OmniarrSyncService"/> maps it
/// onto each app's own resources, where the two schemas differ (Radarr's <c>movieCategory</c>
/// against Sonarr's <c>tvCategory</c>, Radarr's <c>onMovieDelete</c> against Sonarr's
/// <c>onSeriesDelete</c>, and so on).
/// </remarks>
public sealed class SharedSettings
{
    /// <summary>Settings key this document is stored under in <c>core.db</c>.</summary>
    public const string StorageKey = "omniarr";

    public List<IndexerSettings> Indexers { get; set; } = new();

    public DownloadClientSettings DownloadClients { get; set; } = new();

    public RootFolderSettings RootFolders { get; set; } = new();

    public NamingSettings Naming { get; set; } = new();

    public NotificationSettings Notifications { get; set; } = new();

    /// <summary>How this node materializes the group's titles into its own Jellyfin.</summary>
    public FederatedSettings Federated { get; set; } = new();

    /// <summary>
    /// Quality profile to use when adding titles. Empty means "whatever the app's first profile
    /// is", which is what a fresh Radarr or Sonarr always has at least one of.
    /// </summary>
    public string DefaultQualityProfileName { get; set; } = string.Empty;

    /// <summary>Bumped on every write, so a sync can tell whether it has anything to do.</summary>
    public long Revision { get; set; }

    public string UpdatedAt { get; set; } = string.Empty;

    /// <summary>Defaults for a node that has never been configured.</summary>
    public static SharedSettings CreateDefault() => new()
    {
        Indexers = new List<IndexerSettings>(),
        DownloadClients = new DownloadClientSettings(),
        RootFolders = new RootFolderSettings(),
        Naming = new NamingSettings(),
        Notifications = new NotificationSettings(),
        Revision = 1,
        UpdatedAt = DateTime.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
    };

    /// <summary>Find an indexer by its identifier.</summary>
    public IndexerSettings? Indexer(string id)
        => Indexers.FirstOrDefault(i => string.Equals(i.Id, id, StringComparison.OrdinalIgnoreCase));
}

/// <summary>
/// A Torznab indexer, the only indexer protocol M1 supports.
/// </summary>
public sealed class IndexerSettings
{
    /// <summary>Stable identifier, generated when the indexer is added.</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string Name { get; set; } = string.Empty;

    /// <summary>Torznab base URL, e.g. <c>http://127.0.0.1:9117/api/v2.0/indexers/x/results/torznab</c>.</summary>
    public string BaseUrl { get; set; } = string.Empty;

    /// <summary>Path appended to <see cref="BaseUrl"/>. Torznab's convention is <c>/api</c>.</summary>
    public string ApiPath { get; set; } = "/api";

    public string ApiKey { get; set; } = string.Empty;

    public bool Enabled { get; set; } = true;

    /// <summary>1 (highest) to 50. NzbDrone's default is 25.</summary>
    public int Priority { get; set; } = 25;

    public int MinimumSeeders { get; set; } = 1;

    public bool EnableRss { get; set; } = true;

    public bool EnableAutomaticSearch { get; set; } = true;

    public bool EnableInteractiveSearch { get; set; } = true;

    /// <summary>
    /// Newznab categories to search in Radarr. Both apps reject an indexer with an empty category
    /// list outright, so these always have a value.
    /// </summary>
    public List<int> MovieCategories { get; set; } = new() { 2000, 2010, 2020, 2030, 2040, 2045, 2050, 2060 };

    /// <summary>Newznab categories to search in Sonarr.</summary>
    public List<int> TvCategories { get; set; } = new() { 5000, 5010, 5020, 5030, 5040, 5045, 5050 };

    /// <summary>Push this indexer to Radarr.</summary>
    public bool ForMovies { get; set; } = true;

    /// <summary>Push this indexer to Sonarr.</summary>
    public bool ForSeries { get; set; } = true;
}

/// <summary>
/// The two engines StingStream runs itself. Both are always registered in both apps; there is no
/// user choice to make, only whether they are enabled.
/// </summary>
public sealed class DownloadClientSettings
{
    /// <summary>The in-process MonoTorrent engine, presented as qBittorrent.</summary>
    public bool TorrentsEnabled { get; set; } = true;

    /// <summary>Name the client is registered under in both apps.</summary>
    public string TorrentClientName { get; set; } = "StingStream Torrents";

    /// <summary>qBittorrent category for Radarr's downloads.</summary>
    public string TorrentMovieCategory { get; set; } = "radarr";

    /// <summary>qBittorrent category for Sonarr's downloads.</summary>
    public string TorrentTvCategory { get; set; } = "sonarr";

    /// <summary>The supervisor-run NZBGet child.</summary>
    public bool UsenetEnabled { get; set; } = true;

    public string UsenetClientName { get; set; } = "StingStream Usenet";

    /// <summary>NZBGet category for Radarr, which must exist in nzbget.conf or the app's test fails.</summary>
    public string UsenetMovieCategory { get; set; } = "movies";

    /// <summary>NZBGet category for Sonarr.</summary>
    public string UsenetTvCategory { get; set; } = "tv";

    /// <summary>Let the apps delete completed downloads once they have been imported and seeded.</summary>
    public bool RemoveCompletedDownloads { get; set; } = true;

    public bool RemoveFailedDownloads { get; set; } = true;

    /// <summary>
    /// Join the public BitTorrent DHT.
    /// </summary>
    /// <remarks>
    /// Off by default: a headless media server should not quietly join a global peer-to-peer
    /// network without being asked, and every release an indexer hands the arrs carries its own
    /// trackers. The qBittorrent shim reports this state honestly in <c>app/preferences</c>, so
    /// with it off Radarr refuses a trackerless magnet up front instead of stalling on one.
    /// </remarks>
    public bool TorrentDhtEnabled { get; set; }

    /// <summary>Announce to and listen for peers on the local network.</summary>
    public bool TorrentLocalPeerDiscovery { get; set; } = true;

    /// <summary>Port the torrent engine listens on. 0 asks the OS for an ephemeral one.</summary>
    public int TorrentListenPort { get; set; }
}

/// <summary>Where imported media lands. These are the arrs' root folders and Jellyfin's libraries.</summary>
public sealed class RootFolderSettings
{
    /// <summary>Absolute path. Empty means "use the supervisor's <c>media/Movies</c>".</summary>
    public string Movies { get; set; } = string.Empty;

    /// <summary>Absolute path. Empty means "use the supervisor's <c>media/TV</c>".</summary>
    public string Tv { get; set; } = string.Empty;
}

/// <summary>File and folder naming, pushed to both apps' <c>/api/v3/config/naming</c>.</summary>
public sealed class NamingSettings
{
    public bool RenameOnImport { get; set; } = true;

    public bool ReplaceIllegalCharacters { get; set; } = true;

    /// <summary>Radarr's <c>standardMovieFormat</c>.</summary>
    public string MovieFormat { get; set; } =
        "{Movie Title} ({Release Year}) {Quality Full}";

    /// <summary>Radarr's <c>movieFolderFormat</c>.</summary>
    public string MovieFolderFormat { get; set; } = "{Movie Title} ({Release Year})";

    /// <summary>Sonarr's <c>standardEpisodeFormat</c>.</summary>
    public string EpisodeFormat { get; set; } =
        "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}";

    /// <summary>Sonarr's <c>seriesFolderFormat</c>.</summary>
    public string SeriesFolderFormat { get; set; } = "{Series Title}";

    /// <summary>Sonarr's <c>seasonFolderFormat</c>.</summary>
    public string SeasonFolderFormat { get; set; } = "Season {season:00}";
}

/// <summary>
/// The webhook StingStream installs in both apps so an import reaches Jellyfin without a full
/// library scan.
/// </summary>
/// <summary>
/// The federated library: how the group index becomes items in this node's own Jellyfin.
/// </summary>
/// <remarks>
/// See <c>docs/ARCHITECTURE.md</c>, "Federated library". Every value here is a policy decision a
/// user might reasonably want to change; the mechanism itself is not configurable.
/// </remarks>
public sealed class FederatedSettings
{
    /// <summary>
    /// Materialize the group index at all.
    /// </summary>
    /// <remarks>
    /// Turning this off leaves the node in the group -- it still publishes its own inventory and
    /// still serves files to peers -- but its own Jellyfin shows only what it holds locally. That
    /// is what someone with a curated library and a shared seedbox wants.
    /// </remarks>
    public bool Enabled { get; set; } = true;

    /// <summary>How often to compare the group index against what has been materialized.</summary>
    /// <remarks>
    /// The mesh has no change notification of its own, so this is a poll. It is a local SQLite
    /// read over loopback and the diff is a set comparison, so fifteen seconds costs nothing and
    /// makes a peer's new import appear about as fast as a local one.
    /// </remarks>
    public int PollIntervalSeconds { get; set; } = 15;

    /// <summary>
    /// How long a holder may stay offline before its pointers are deleted rather than greyed out.
    /// </summary>
    /// <remarks>
    /// A laptop that is off for a weekend should not cost its owner's group the whole library, so
    /// the default is a week. Set it to 0 to remove a peer's titles as soon as it goes offline.
    /// </remarks>
    public int OfflineGraceDays { get; set; } = 7;

    /// <summary>Fetch artwork from the holding node over the mesh.</summary>
    public bool FetchImages { get; set; } = true;
}

public sealed class NotificationSettings
{
    public bool WebhookEnabled { get; set; } = true;

    public string WebhookName { get; set; } = "StingStream";

    /// <summary>
    /// Absolute URL of the receiver. Empty means "work it out from runtime.json", which is what
    /// normally happens -- the apps and Jellyfin are all on loopback and the port is assigned at
    /// start-up, so a hard-coded URL would go stale on the next restart.
    /// </summary>
    public string WebhookUrl { get; set; } = string.Empty;

    public bool OnGrab { get; set; } = true;

    /// <summary>The import event. Both apps call it "onDownload"; neither has an "onImport".</summary>
    public bool OnDownload { get; set; } = true;

    public bool OnUpgrade { get; set; } = true;

    public bool OnRename { get; set; } = true;

    public bool OnDelete { get; set; } = true;

    /// <summary>Extra webhook targets the user has configured, delivered alongside StingStream's own.</summary>
    public List<ExtraWebhook> Extra { get; set; } = new();
}

/// <summary>A user-configured webhook, registered in both apps alongside StingStream's own.</summary>
public sealed class ExtraWebhook
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string Name { get; set; } = string.Empty;

    public string Url { get; set; } = string.Empty;

    /// <summary>1 for POST, 2 for PUT -- NzbDrone's <c>WebhookMethod</c> enum is not zero-based.</summary>
    public int Method { get; set; } = 1;

    public string Username { get; set; } = string.Empty;

    public string Password { get; set; } = string.Empty;

    public bool Enabled { get; set; } = true;
}

/// <summary>Result of the last sync into one app.</summary>
public sealed class SyncStatus
{
    public string App { get; set; } = string.Empty;

    public bool Ok { get; set; }

    public string Message { get; set; } = string.Empty;

    /// <summary>Per-resource detail: what was created, updated or left alone.</summary>
    public List<string> Detail { get; set; } = new();

    public string UpdatedAt { get; set; } = string.Empty;
}
