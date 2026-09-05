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

    /// <summary>
    /// Download clients somebody else runs, registered in both arrs alongside the embedded ones.
    /// </summary>
    /// <remarks>
    /// The answer to <c>docs/UI-API-GAPS.md</c> gap 8, and the answer is yes: StingStream supports
    /// bring-your-own-client. Not because the embedded engines are insufficient, but because a
    /// person migrating to StingStream already has a seedbox or a SABnzbd with a queue in it, and
    /// "move all of that first" is a bad first day. These are pushed into both apps exactly the way
    /// indexers are — built from the app's own <c>downloadclient/schema</c>, matched by name,
    /// idempotent.
    /// </remarks>
    public List<ExternalDownloadClientSettings> ExternalDownloadClients { get; set; } = new();

    public RootFolderSettings RootFolders { get; set; } = new();

    public NamingSettings Naming { get; set; } = new();

    public NotificationSettings Notifications { get; set; } = new();

    /// <summary>How this node materializes the group's titles into its own Jellyfin.</summary>
    public FederatedSettings Federated { get; set; } = new();

    /// <summary>What subtitles the group wants, and whether to go and get them (M7).</summary>
    public SubtitleSettings Subtitles { get; set; } = new();

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

    /// <summary>Find an external download client by its identifier.</summary>
    public ExternalDownloadClientSettings? ExternalDownloadClient(string id)
        => ExternalDownloadClients.FirstOrDefault(
            c => string.Equals(c.Id, id, StringComparison.OrdinalIgnoreCase));
}

/// <summary>
/// A download client running somewhere else, registered in both arrs.
/// </summary>
/// <remarks>
/// Deliberately not modelled per implementation. Every client NzbDrone supports declares its own
/// <c>fields</c> array, and the four below (<c>host</c>, <c>port</c>, <c>useSsl</c>,
/// <c>urlBase</c>) plus credentials and a category are the ones every one of them has — so
/// <see cref="Arr.OmniarrSyncService"/> sets those on whatever schema the app hands back and
/// leaves each implementation's own extras at their defaults. That covers qBittorrent,
/// Transmission, Deluge, SABnzbd, rTorrent and NZBGet without StingStream carrying a copy of six
/// settings classes that change with every upstream release.
/// </remarks>
public sealed class ExternalDownloadClientSettings
{
    /// <summary>Stable identifier, generated when the client is added.</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>The name it is registered under in both apps. Must be unique.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// NzbDrone's implementation name, e.g. <c>QBittorrent</c>, <c>Sabnzbd</c>, <c>Transmission</c>,
    /// <c>Deluge</c>, <c>Nzbget</c>, <c>RTorrent</c>.
    /// </summary>
    /// <remarks>
    /// Matched case-insensitively against the app's own <c>downloadclient/schema</c>, so an
    /// implementation one app has and the other does not (or a typo) is reported per app rather
    /// than failing the whole sync.
    /// </remarks>
    public string Implementation { get; set; } = string.Empty;

    /// <summary><c>torrent</c> or <c>usenet</c>. Both apps validate this against the implementation.</summary>
    public string Protocol { get; set; } = "torrent";

    public string Host { get; set; } = string.Empty;

    public int Port { get; set; }

    public bool UseSsl { get; set; }

    /// <summary>Path prefix, when the client is behind a reverse proxy. Usually empty.</summary>
    public string UrlBase { get; set; } = string.Empty;

    public string Username { get; set; } = string.Empty;

    public string Password { get; set; } = string.Empty;

    /// <summary>Category for Radarr's downloads, when this client is used for movies.</summary>
    public string MovieCategory { get; set; } = string.Empty;

    /// <summary>Category for Sonarr's downloads.</summary>
    public string TvCategory { get; set; } = string.Empty;

    public bool Enabled { get; set; } = true;

    /// <summary>1 (highest) to 50. The embedded engines register at 1, so 2 is a sensible default.</summary>
    public int Priority { get; set; } = 2;

    /// <summary>Push this client to Radarr.</summary>
    public bool ForMovies { get; set; } = true;

    /// <summary>Push this client to Sonarr.</summary>
    public bool ForSeries { get; set; } = true;

    /// <summary>Let the apps delete completed downloads once imported.</summary>
    public bool RemoveCompletedDownloads { get; set; } = true;

    public bool RemoveFailedDownloads { get; set; } = true;
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
/// <summary>
/// The languages this group wants subtitles in, and whether this node fetches them.
/// </summary>
/// <remarks>
/// <para>
/// A group setting rather than a per-user one, deliberately. The point of it is that a title
/// imported on *any* node arrives with subtitles for *everybody* — the holder fetches them once and
/// publishes them with the inventory record, so every member's materialised copy has them without
/// each node asking OpenSubtitles for the same file. A per-user preference cannot express that,
/// because the node doing the fetching may have no user who wants that language at all.
/// </para>
/// <para>
/// It is stored per node and each node acts on its own copy, which means the group agrees only as
/// far as its members configure the same thing. That is the same shape as every other setting here
/// and is the honest v1: a shared, gossiped policy needs a writer and a conflict rule, which is
/// M8's territory alongside revocation.
/// </para>
/// </remarks>
public sealed class SubtitleSettings
{
    /// <summary>Go and fetch missing subtitles at all.</summary>
    /// <remarks>
    /// On by default, because the alternative is a feature nobody discovers. Off is the right
    /// answer for a node whose owner curates subtitles by hand, and for one with no internet.
    /// </remarks>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Three-letter ISO language codes, in preference order. Empty means "this node's UI language".
    /// </summary>
    /// <remarks>
    /// Empty rather than a hard-coded <c>eng</c>: a node set up in German should want German
    /// subtitles without anybody configuring anything, and the server already knows its own
    /// <c>UICulture</c>. First-run fills this in from it, so what is stored afterwards is explicit.
    /// </remarks>
    public List<string> Languages { get; set; } = new();

    /// <summary>Fetch a peer's subtitle sidecars when materializing its titles.</summary>
    /// <remarks>
    /// Separate from <see cref="Enabled"/> because the two cost different things. Fetching a peer's
    /// existing sidecars is a few kilobytes over a connection that is already open; going out to a
    /// subtitle provider is an internet round trip and a rate limit.
    /// </remarks>
    public bool FetchFromPeers { get; set; } = true;

    /// <summary>How many items one pass may fetch subtitles for.</summary>
    /// <remarks>
    /// OpenSubtitles allows a handful of downloads a day for an anonymous account and ten for a
    /// registered one, so a first scan of a large library must not try to fetch for all of it at
    /// once. A small batch per pass gets through the backlog over hours instead of being refused
    /// in the first minute.
    /// </remarks>
    public int MaxFetchesPerPass { get; set; } = 5;
}

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

    /// <summary>
    /// Copy every film the group holds into this node's own Movies folder.
    /// </summary>
    /// <remarks>
    /// The "mirror everything" toggle, per library. Off by default, and it should stay off on a
    /// laptop: the whole point of the federated library is that one copy is enough. It is on for a
    /// seedbox or an always-on node someone wants to be the group's backstop, and the background
    /// job that acts on it is capacity-aware — it stops at <see cref="MirrorMinFreeBytes"/> and runs
    /// at most <see cref="MirrorConcurrency"/> copies at once, so mirroring never starves playback.
    /// </remarks>
    public bool MirrorMovies { get; set; }

    /// <summary>Copy every episode the group holds into this node's own TV folder.</summary>
    public bool MirrorTv { get; set; }

    /// <summary>
    /// How many pins one pass may copy, mirror or hand-requested.
    /// </summary>
    /// <remarks>
    /// One by default. A pin is a whole film over someone else's uplink; running four at once makes
    /// all four slower, and makes the stream-capacity numbers a holder advertises a fiction — so
    /// <see cref="Federated.PinService"/> awaits each pin before starting the next, and this is a
    /// budget <em>per pass</em> rather than a number running concurrently. The name is kept for the
    /// settings documents already written with it.
    /// </remarks>
    public int MirrorConcurrency { get; set; } = 1;

    /// <summary>Stop mirroring when the media volume has less than this much free.</summary>
    public long MirrorMinFreeBytes { get; set; } = 20L * 1024 * 1024 * 1024;
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
