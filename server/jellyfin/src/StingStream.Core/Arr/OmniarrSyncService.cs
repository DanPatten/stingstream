using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;
using StingStream.Core.Data;

namespace StingStream.Core.Arr;

/// <summary>
/// Pushes the one shared settings model into Radarr and Sonarr through their v3 APIs.
/// </summary>
/// <remarks>
/// This is the "Omniarr" half of making two apps look like one: the user configures indexers,
/// download clients, root folders, naming and notifications once, and this service maps that onto
/// each app's own resources. It is the same pattern Prowlarr uses for indexers, extended to
/// everything else.
///
/// Every operation is idempotent and matched by name, so running a sync repeatedly converges
/// rather than accumulating duplicates. Provider resources are built from the app's own
/// <c>/schema</c> response, which keeps the mapping honest across upstream churn: field names,
/// types and defaults come from the running app rather than from a copy of its settings class.
///
/// Where the two schemas genuinely differ, the difference is explicit and commented, not hidden
/// behind a shared abstraction.
/// </remarks>
public sealed class OmniarrSyncService
{
    // Implementation identifiers, identical in both apps (verified against
    // server/radarr/src/NzbDrone.Core and server/sonarr/src/NzbDrone.Core).
    private const string QBittorrentImplementation = "QBittorrent";
    private const string NzbgetImplementation = "Nzbget";
    private const string TorznabImplementation = "Torznab";
    private const string WebhookImplementation = "Webhook";

    private readonly ArrClientFactory _factory;
    private readonly SettingsStore _settings;
    private readonly ILogger<OmniarrSyncService> _logger;

    public OmniarrSyncService(
        ArrClientFactory factory,
        SettingsStore settings,
        ILogger<OmniarrSyncService> logger)
    {
        _factory = factory;
        _settings = settings;
        _logger = logger;
    }

    /// <summary>
    /// Push the current shared settings into every configured app.
    /// </summary>
    /// <param name="waitFor">
    /// How long to wait for an app that is not answering yet. First-run wiring passes a generous
    /// value because the apps are still starting; a user-triggered sync passes a short one.
    /// </param>
    public async Task<List<SyncStatus>> SyncAllAsync(TimeSpan waitFor, CancellationToken ct = default)
    {
        var shared = _settings.Get();
        var results = new List<SyncStatus>();

        foreach (var client in _factory.CreateAll())
        {
            var status = await SyncOneAsync(client, shared, waitFor, ct).ConfigureAwait(false);
            results.Add(status);
            await _settings.RecordSyncAsync(status, ct).ConfigureAwait(false);
        }

        if (results.Count == 0)
        {
            _logger.LogWarning(
                "Omniarr sync had nothing to do: no arr is configured in runtime.json. "
                + "Is this Jellyfin running under the StingStream supervisor?");
        }

        return results;
    }

    /// <summary>Push the shared settings into one app.</summary>
    public async Task<SyncStatus> SyncOneAsync(
        ArrClient client,
        SharedSettings shared,
        TimeSpan waitFor,
        CancellationToken ct = default)
    {
        var status = new SyncStatus { App = client.Name };

        if (!await client.WaitUntilReachableAsync(waitFor, ct).ConfigureAwait(false))
        {
            status.Ok = false;
            status.Message = $"{client.Name} did not answer at {client.BaseUrl} within {waitFor.TotalSeconds:0}s";
            _logger.LogWarning("{Message}", status.Message);
            return status;
        }

        try
        {
            await SyncRootFoldersAsync(client, shared, status, ct).ConfigureAwait(false);
            await SyncDownloadClientsAsync(client, shared, status, ct).ConfigureAwait(false);
            await SyncIndexersAsync(client, shared, status, ct).ConfigureAwait(false);
            await SyncNamingAsync(client, shared, status, ct).ConfigureAwait(false);
            await SyncNotificationsAsync(client, shared, status, ct).ConfigureAwait(false);

            status.Ok = true;
            status.Message = $"Synced {status.Detail.Count} change(s) into {client.Name}";
            _logger.LogInformation("{Message}", status.Message);
        }
        catch (ArrApiException ex)
        {
            status.Ok = false;
            status.Message = ex.Message;
            _logger.LogError(ex, "Omniarr sync into {App} failed", client.Name);
        }
        catch (Exception ex) when (ex is System.Net.Http.HttpRequestException or TaskCanceledException)
        {
            status.Ok = false;
            status.Message = $"{client.Name} became unreachable during sync: {ex.Message}";
            _logger.LogError(ex, "Omniarr sync into {App} failed", client.Name);
        }

        return status;
    }

    // --- root folders ------------------------------------------------------

    private async Task SyncRootFoldersAsync(
        ArrClient client,
        SharedSettings shared,
        SyncStatus status,
        CancellationToken ct)
    {
        var runtime = _factory.Runtime;
        // Radarr gets the movies folder and Sonarr the TV one. Neither ever gets the other's, and
        // neither ever gets the federated pointer tree -- both apps treat .strm as a video
        // extension, so a root folder over it would have them try to manage other nodes' files.
        var path = client.Kind == ArrKind.Radarr
            ? Coalesce(shared.RootFolders.Movies, runtime?.Paths.MediaMovies)
            : Coalesce(shared.RootFolders.Tv, runtime?.Paths.MediaTv);

        if (string.IsNullOrWhiteSpace(path))
        {
            status.Detail.Add("root folder: skipped (no path configured and no runtime.json)");
            return;
        }

        System.IO.Directory.CreateDirectory(path);
        var added = await client.EnsureRootFolderAsync(path, ct).ConfigureAwait(false);
        status.Detail.Add(added ? $"root folder: added {path}" : $"root folder: {path} already present");
    }

    private static string Coalesce(string? preferred, string? fallback)
        => !string.IsNullOrWhiteSpace(preferred) ? preferred : fallback ?? string.Empty;

    // --- download clients --------------------------------------------------

    private async Task SyncDownloadClientsAsync(
        ArrClient client,
        SharedSettings shared,
        SyncStatus status,
        CancellationToken ct)
    {
        var runtime = _factory.Runtime;
        if (runtime is null)
        {
            status.Detail.Add("download clients: skipped (no runtime.json)");
            return;
        }

        if (shared.DownloadClients.TorrentsEnabled)
        {
            var jellyfin = _factory.Jellyfin;
            if (jellyfin is null)
            {
                status.Detail.Add("torrent client: skipped (Jellyfin is not in runtime.json)");
            }
            else
            {
                var schema = await client.GetSchemaAsync("downloadclient", QBittorrentImplementation, ct)
                    .ConfigureAwait(false);
                if (schema is null)
                {
                    status.Detail.Add("torrent client: skipped (this app has no QBittorrent implementation)");
                }
                else
                {
                    var resource = schema.DeepClone().AsObject();
                    resource["name"] = shared.DownloadClients.TorrentClientName;
                    resource["enable"] = true;
                    resource["protocol"] = "torrent";
                    resource["priority"] = 1;
                    resource["removeCompletedDownloads"] = shared.DownloadClients.RemoveCompletedDownloads;
                    resource["removeFailedDownloads"] = shared.DownloadClients.RemoveFailedDownloads;
                    resource["tags"] = new JsonArray();

                    // The qBittorrent-compatible shim runs inside this very process, so the arrs
                    // dial Jellyfin's port. Jellyfin's own BaseUrl is part of the path because
                    // ASP.NET maps every route beneath it -- runtime.json's qbittorrent.url_base
                    // already includes it.
                    ArrClient.SetField(resource, "host", "127.0.0.1");
                    ArrClient.SetField(resource, "port", jellyfin.Port);
                    ArrClient.SetField(resource, "useSsl", false);
                    ArrClient.SetField(resource, "urlBase", runtime.Qbittorrent.UrlBase);
                    ArrClient.SetField(resource, "username", runtime.Qbittorrent.Username);
                    ArrClient.SetField(resource, "password", runtime.Qbittorrent.Password);
                    // Radarr calls this movieCategory and Sonarr tvCategory. Setting both is
                    // harmless -- SetField only writes fields the app actually declared -- and
                    // keeps the mapping in one place.
                    ArrClient.SetField(resource, "movieCategory", shared.DownloadClients.TorrentMovieCategory);
                    ArrClient.SetField(resource, "tvCategory", shared.DownloadClients.TorrentTvCategory);

                    await client.UpsertProviderAsync("downloadclient", resource, ct).ConfigureAwait(false);
                    status.Detail.Add(
                        $"torrent client: {shared.DownloadClients.TorrentClientName} -> "
                        + $"127.0.0.1:{jellyfin.Port}{runtime.Qbittorrent.UrlBase}");
                }
            }
        }

        if (shared.DownloadClients.UsenetEnabled)
        {
            var nzbget = _factory.Nzbget;
            if (nzbget is null)
            {
                status.Detail.Add("usenet client: skipped (NZBGet is not enabled on this node)");
            }
            else
            {
                var schema = await client.GetSchemaAsync("downloadclient", NzbgetImplementation, ct)
                    .ConfigureAwait(false);
                if (schema is null)
                {
                    status.Detail.Add("usenet client: skipped (this app has no Nzbget implementation)");
                }
                else
                {
                    var resource = schema.DeepClone().AsObject();
                    resource["name"] = shared.DownloadClients.UsenetClientName;
                    resource["enable"] = true;
                    resource["protocol"] = "usenet";
                    resource["priority"] = 1;
                    resource["removeCompletedDownloads"] = shared.DownloadClients.RemoveCompletedDownloads;
                    resource["removeFailedDownloads"] = shared.DownloadClients.RemoveFailedDownloads;
                    resource["tags"] = new JsonArray();

                    ArrClient.SetField(resource, "host", "127.0.0.1");
                    ArrClient.SetField(resource, "port", nzbget.Port);
                    ArrClient.SetField(resource, "useSsl", false);
                    ArrClient.SetField(resource, "urlBase", string.Empty);
                    ArrClient.SetField(resource, "username", nzbget.Username ?? string.Empty);
                    ArrClient.SetField(resource, "password", nzbget.Password ?? string.Empty);
                    // The categories the supervisor wrote into nzbget.conf. Both apps validate
                    // that the configured category exists in NZBGet's own config, so these names
                    // must match preseed::nzbget::CATEGORY_MOVIES / CATEGORY_TV exactly.
                    ArrClient.SetField(resource, "movieCategory", shared.DownloadClients.UsenetMovieCategory);
                    ArrClient.SetField(resource, "tvCategory", shared.DownloadClients.UsenetTvCategory);

                    await client.UpsertProviderAsync("downloadclient", resource, ct).ConfigureAwait(false);
                    status.Detail.Add(
                        $"usenet client: {shared.DownloadClients.UsenetClientName} -> 127.0.0.1:{nzbget.Port}");
                }
            }
        }
    }

    // --- indexers ----------------------------------------------------------

    private async Task SyncIndexersAsync(
        ArrClient client,
        SharedSettings shared,
        SyncStatus status,
        CancellationToken ct)
    {
        var wanted = shared.Indexers
            .Where(i => i.Enabled && (client.Kind == ArrKind.Radarr ? i.ForMovies : i.ForSeries))
            .ToList();

        if (wanted.Count == 0)
        {
            status.Detail.Add("indexers: none configured for this app");
            return;
        }

        var schema = await client.GetSchemaAsync("indexer", TorznabImplementation, ct).ConfigureAwait(false);
        if (schema is null)
        {
            status.Detail.Add("indexers: skipped (this app has no Torznab implementation)");
            return;
        }

        foreach (var indexer in wanted)
        {
            var resource = schema.DeepClone().AsObject();
            resource["name"] = indexer.Name;
            resource["enableRss"] = indexer.EnableRss;
            resource["enableAutomaticSearch"] = indexer.EnableAutomaticSearch;
            resource["enableInteractiveSearch"] = indexer.EnableInteractiveSearch;
            resource["protocol"] = "torrent";
            resource["priority"] = indexer.Priority;
            resource["downloadClientId"] = 0;
            resource["tags"] = new JsonArray();

            ArrClient.SetField(resource, "baseUrl", indexer.BaseUrl);
            ArrClient.SetField(resource, "apiPath", indexer.ApiPath);
            ArrClient.SetField(resource, "apiKey", indexer.ApiKey);
            ArrClient.SetField(resource, "minimumSeeders", indexer.MinimumSeeders);
            // Both apps' Torznab validator rejects an empty category list outright, and the two
            // apps want different halves of the Newznab category tree.
            var categories = client.Kind == ArrKind.Radarr ? indexer.MovieCategories : indexer.TvCategories;
            ArrClient.SetField(resource, "categories", ToJsonArray(categories));
            // Sonarr additionally declares animeCategories; leaving it empty is valid there and
            // the field simply does not exist in Radarr.
            ArrClient.SetField(resource, "animeCategories", new JsonArray());

            await client.UpsertProviderAsync("indexer", resource, ct).ConfigureAwait(false);
            status.Detail.Add($"indexer: {indexer.Name} -> {indexer.BaseUrl}{indexer.ApiPath}");
        }
    }

    private static JsonArray ToJsonArray(IEnumerable<int> values)
    {
        var arr = new JsonArray();
        foreach (var v in values)
        {
            arr.Add(v);
        }

        return arr;
    }

    // --- naming ------------------------------------------------------------

    private async Task SyncNamingAsync(
        ArrClient client,
        SharedSettings shared,
        SyncStatus status,
        CancellationToken ct)
    {
        // config/naming is a singleton resource: GET it, change the fields we own, PUT it back.
        // Overwriting the whole document would drop settings the app added in a version we do not
        // know about.
        var current = await client.GetAsync("config/naming", ct).ConfigureAwait(false) as JsonObject;
        if (current is null)
        {
            status.Detail.Add("naming: skipped (config/naming is unavailable)");
            return;
        }

        current["renameMovies"] = shared.Naming.RenameOnImport;
        current["renameEpisodes"] = shared.Naming.RenameOnImport;
        current["replaceIllegalCharacters"] = shared.Naming.ReplaceIllegalCharacters;

        if (client.Kind == ArrKind.Radarr)
        {
            current["standardMovieFormat"] = shared.Naming.MovieFormat;
            current["movieFolderFormat"] = shared.Naming.MovieFolderFormat;
        }
        else
        {
            current["standardEpisodeFormat"] = shared.Naming.EpisodeFormat;
            current["seriesFolderFormat"] = shared.Naming.SeriesFolderFormat;
            current["seasonFolderFormat"] = shared.Naming.SeasonFolderFormat;
        }

        var id = current["id"]?.GetValue<int>() ?? 1;
        await client.PutAsync($"config/naming/{id}", current, ct).ConfigureAwait(false);
        status.Detail.Add("naming: updated");
    }

    // --- notifications -----------------------------------------------------

    private async Task SyncNotificationsAsync(
        ArrClient client,
        SharedSettings shared,
        SyncStatus status,
        CancellationToken ct)
    {
        if (!shared.Notifications.WebhookEnabled)
        {
            status.Detail.Add("webhook: disabled");
            return;
        }

        var schema = await client.GetSchemaAsync("notification", WebhookImplementation, ct).ConfigureAwait(false);
        if (schema is null)
        {
            status.Detail.Add("webhook: skipped (this app has no Webhook implementation)");
            return;
        }

        var url = ResolveWebhookUrl(shared, client);
        if (string.IsNullOrWhiteSpace(url))
        {
            status.Detail.Add("webhook: skipped (could not work out a receiver URL)");
            return;
        }

        var resource = BuildWebhook(
            schema,
            shared.Notifications.WebhookName,
            url,
            client.Kind,
            shared.Notifications,
            username: string.Empty,
            password: string.Empty,
            method: 1);

        await client.UpsertProviderAsync("notification", resource, ct).ConfigureAwait(false);
        status.Detail.Add($"webhook: {shared.Notifications.WebhookName} -> {url}");

        foreach (var extra in shared.Notifications.Extra.Where(e => e.Enabled && !string.IsNullOrWhiteSpace(e.Url)))
        {
            var extraResource = BuildWebhook(
                schema,
                extra.Name,
                extra.Url,
                client.Kind,
                shared.Notifications,
                extra.Username,
                extra.Password,
                extra.Method);
            await client.UpsertProviderAsync("notification", extraResource, ct).ConfigureAwait(false);
            status.Detail.Add($"webhook: {extra.Name} -> {extra.Url}");
        }
    }

    private JsonObject BuildWebhook(
        JsonObject schema,
        string name,
        string url,
        ArrKind kind,
        NotificationSettings settings,
        string username,
        string password,
        int method)
    {
        var resource = schema.DeepClone().AsObject();
        resource["name"] = name;
        resource["tags"] = new JsonArray();

        // The event flags are on the resource itself, not in `fields`, and this is where the two
        // apps' schemas diverge most: there is no "onImport" in either -- the import event is
        // "onDownload" -- and the delete events are named after each app's own entity.
        resource["onGrab"] = settings.OnGrab;
        resource["onDownload"] = settings.OnDownload;
        resource["onUpgrade"] = settings.OnUpgrade;
        resource["onRename"] = settings.OnRename;
        resource["onHealthIssue"] = false;
        resource["includeHealthWarnings"] = false;
        resource["onApplicationUpdate"] = false;

        if (kind == ArrKind.Radarr)
        {
            resource["onMovieAdded"] = false;
            resource["onMovieDelete"] = settings.OnDelete;
            resource["onMovieFileDelete"] = settings.OnDelete;
            resource["onMovieFileDeleteForUpgrade"] = false;
        }
        else
        {
            // Sonarr also fires onImportComplete once per import batch, which is the cheapest
            // possible trigger for a targeted Jellyfin refresh of a whole season.
            resource["onImportComplete"] = settings.OnDownload;
            resource["onSeriesAdd"] = false;
            resource["onSeriesDelete"] = settings.OnDelete;
            resource["onEpisodeFileDelete"] = settings.OnDelete;
            resource["onEpisodeFileDeleteForUpgrade"] = false;
        }

        ArrClient.SetField(resource, "url", url);
        ArrClient.SetField(resource, "method", method);
        ArrClient.SetField(resource, "username", username);
        ArrClient.SetField(resource, "password", password);
        return resource;
    }

    /// <summary>
    /// Where the arrs should POST their events.
    /// </summary>
    /// <remarks>
    /// Derived from <c>runtime.json</c> rather than stored, because the receiver lives inside
    /// Jellyfin on a supervisor-assigned port: a URL saved on one run would be wrong on the next.
    /// </remarks>
    private string ResolveWebhookUrl(SharedSettings shared, ArrClient client)
    {
        if (!string.IsNullOrWhiteSpace(shared.Notifications.WebhookUrl))
        {
            return shared.Notifications.WebhookUrl;
        }

        var jellyfin = _factory.Jellyfin;
        if (jellyfin is null)
        {
            return string.Empty;
        }

        var app = client.Kind == ArrKind.Radarr ? "radarr" : "sonarr";
        return string.Create(
            CultureInfo.InvariantCulture,
            $"http://127.0.0.1:{jellyfin.Port}{jellyfin.UrlBase}/stingstream/api/v1/webhooks/arr?app={app}");
    }
}
