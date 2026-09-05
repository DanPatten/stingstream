using System;
using System.Linq;
using System.Net.Http;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.OpenApi;
using StingStream.Core.Arr;
using StingStream.Core.Configuration;
using StingStream.Core.Controllers;
using StingStream.Core.Data;
using StingStream.Core.Federated;
using StingStream.Core.FirstRun;
using StingStream.Core.Inventory;
using StingStream.Core.Library;
using StingStream.Core.Mesh;
using StingStream.Core.Playback;
using StingStream.Core.Requests;
using StingStream.Core.SyncPlay;
using StingStream.Core.Torrents;
using StingStream.Core.Webhooks;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace StingStream.Core;

/// <summary>
/// Marker type. Referencing it from <c>Jellyfin.Server</c>'s <c>CoreAppHost</c> is what puts this
/// assembly into Jellyfin's composable-parts list, which is in turn what makes its controllers
/// discoverable -- <c>AddJellyfinApi</c> clears every auto-discovered application part and re-adds
/// only Jellyfin.Api plus the assemblies that list reports.
/// </summary>
public static class StingStreamCoreMarker
{
    /// <summary>This assembly.</summary>
    public static System.Reflection.Assembly Assembly => typeof(StingStreamCoreMarker).Assembly;
}

/// <summary>
/// Registers StingStream.Core inside Jellyfin's host.
/// </summary>
/// <remarks>
/// Two call sites in <c>Jellyfin.Server/Startup.cs</c> and one line in <c>CoreAppHost.cs</c> are
/// the entire footprint of StingStream inside the Jellyfin fork; see <c>docs/PATCHES.md</c>.
/// Everything else lives in this project.
/// </remarks>
public static class StingStreamCoreExtensions
{
    /// <summary>Register every StingStream.Core service.</summary>
    /// <param name="services">The service collection.</param>
    /// <returns>The service collection, for chaining.</returns>
    public static IServiceCollection AddStingStreamCore(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        // Configuration and storage.
        services.AddSingleton<INodeRuntimeProvider, NodeRuntimeProvider>();
        services.AddSingleton<CoreDatabase>();
        services.AddSingleton<SettingsStore>();

        // Talking to the arrs.
        services.AddHttpClient(ArrClient.HttpClientName, client =>
        {
            // The arrs are on loopback. A generous timeout only matters for a first-run request
            // that arrives while one is still migrating its database.
            client.Timeout = TimeSpan.FromSeconds(60);
        });
        services.AddHttpClient(QbtController.HttpClientName, client =>
        {
            client.Timeout = TimeSpan.FromSeconds(60);
        });
        services.AddSingleton<ArrClientFactory>();
        services.AddSingleton<OmniarrSyncService>();
        services.AddSingleton<QualityProfileService>();

        // NZBGet's own control API, which is how the unified Downloads list reaches the usenet half.
        // Short timeout: it is on loopback, and a Downloads screen polling every few seconds must
        // not queue up behind a child that has stopped answering.
        services.AddHttpClient(StingStream.Core.Downloads.NzbgetClient.HttpClientName, client =>
        {
            client.Timeout = TimeSpan.FromSeconds(15);
        });
        services.AddSingleton<StingStream.Core.Downloads.NzbgetClientFactory>();
        services.AddSingleton<StingStream.Core.Downloads.DownloadsService>();
        services.AddSingleton<ChildVersionService>();

        // Torrents. Registered once and resolved as both the concrete engine and a hosted service,
        // so the qBittorrent shim and the lifecycle share one instance.
        services.AddSingleton<TorrentEngine>();
        services.AddHostedService(sp => sp.GetRequiredService<TorrentEngine>());
        services.AddSingleton<QbtSessionStore>();

        // Inventory and hashing.
        services.AddSingleton<IIdleSignal, SessionIdleSignal>();
        services.AddSingleton<HashingService>();
        services.AddHostedService(sp => sp.GetRequiredService<HashingService>());
        services.AddSingleton<InventoryChangeFeed>();
        services.AddSingleton<IInventoryService, InventoryService>();

        // Making Jellyfin notice a file that has just appeared, without a library scan. Shared by
        // the arr import webhooks and the federated materializer, which have the same problem.
        services.AddSingleton<IPathRefresher, PathRefresher>();

        // Webhooks.
        services.AddSingleton<ArrWebhookService>();

        // The mesh, and the federated library it feeds.
        //
        // The named client gets a generous timeout: a join dials the inviter and then every
        // rendezvous entry in turn, and a file range can be a large read over someone else's
        // uplink. Individual calls tighten it where they know better.
        services.AddHttpClient(MeshClient.HttpClientName, client =>
        {
            client.Timeout = TimeSpan.FromSeconds(30);
        });
        services.AddSingleton<IMeshClient, MeshClient>();
        services.AddSingleton<FederatedStore>();
        services.AddSingleton<InventoryPublisher>();
        services.AddHostedService(sp => sp.GetRequiredService<InventoryPublisher>());
        services.AddSingleton<FederatedLibraryService>();
        services.AddHostedService(sp => sp.GetRequiredService<FederatedLibraryService>());

        // Source selection (M4). The decorator is registered as Jellyfin's own
        // IMediaSourceDecorator, which is what puts it in the path of every PlaybackInfo *and*
        // every server-side media-source resolve -- see docs/PATCHES.md for the one hook that
        // makes that possible.
        services.AddSingleton<PlaybackPolicyStore>();
        services.AddSingleton<FederatedSourceService>();
        services.AddSingleton<FederatedSourceDecorator>();
        services.AddSingleton<MediaBrowser.Controller.Library.IMediaSourceDecorator>(
            sp => sp.GetRequiredService<FederatedSourceDecorator>());

        // ...and again, on the way out. MediaInfoController re-sorts the sources *after* the
        // decorator has run, floating "the source belonging to the queried item" to the front --
        // which for a federated title is whichever .strm Jellyfin's resolver happened to read
        // first, and has nothing to do with which holder can actually serve it. See
        // PlaybackInfoOrderFilter for why that upstream rule is right for the case it was written
        // for and wrong for this one.
        services.AddSingleton<PlaybackInfoOrderFilter>();
        services.Configure<Microsoft.AspNetCore.Mvc.MvcOptions>(
            options => options.Filters.AddService<PlaybackInfoOrderFilter>());

        // Pin and mirror.
        services.AddSingleton<LibraryStateStore>();
        services.AddSingleton<PinStore>();
        services.AddSingleton<PinService>();
        services.AddHostedService(sp => sp.GetRequiredService<PinService>());

        // Member requests (M6). One call, defined in Requests/RequestsRegistration.cs.
        services.AddStingStreamRequests();

        // Watch together across nodes (M7). Within one node Jellyfin's own SyncPlay already covers
        // federated items -- a peer's `.strm` is an ordinary library item to it -- so this exists
        // only for the case it cannot reach: two friends on two different nodes. Nothing here
        // decorates or replaces `ISyncPlayManager`; the bridge holds an ordinary session seat in
        // the local group and drives it through the public API. See SyncPlay/WatchBridge.cs.
        services.AddSingleton<IWatchMeshClient, WatchMeshClient>();
        services.AddSingleton<WatchBridge>();
        services.AddHostedService(sp => sp.GetRequiredService<WatchBridge>());

        AddStingStreamLocalResolution(services);

        // First-run wiring, last so everything it needs already exists.
        services.AddSingleton<FirstRunService>();
        services.AddHostedService(sp => sp.GetRequiredService<FirstRunService>());

        AddStingStreamSwagger(services);

        return services;
    }

    /// <summary>
    /// Teach Jellyfin's own HTTP clients how to reach <c>stingstream.local</c>.
    /// </summary>
    /// <remarks>
    /// A federated <c>.strm</c> holds a URL on that marker host. The native app rewrites it to its
    /// own embedded mesh; a browser or a stock client instead has this node's Jellyfin fetch it,
    /// and Jellyfin does that with an ordinary <see cref="System.Net.Http.HttpClient"/>
    /// (<c>FileStreamResponseHelpers.GetStaticRemoteStreamResult</c>) whose <c>Range</c> handling
    /// is exactly what a seeking player needs. All that is missing is resolution, which
    /// <see cref="StingStreamLocalHandler"/> supplies by pointing the request at this node's own
    /// gateway.
    ///
    /// Named-client configuration is additive, so calling <c>AddHttpClient</c> again here composes
    /// with Jellyfin's own registration in <c>Jellyfin.Server/Startup.cs</c> rather than replacing
    /// it -- which matters, because this method runs *before* that one.
    /// </remarks>
    private static void AddStingStreamLocalResolution(IServiceCollection services)
    {
        services.AddTransient<StingStreamLocalHandler>();
        foreach (var name in new[]
                 {
                     MediaBrowser.Common.Net.NamedClient.Default,
                     MediaBrowser.Common.Net.NamedClient.DirectIp,
                 })
        {
            services.AddHttpClient(name).AddHttpMessageHandler<StingStreamLocalHandler>();
        }
    }

    /// <summary>
    /// Add a second OpenAPI document for the StingStream API.
    /// </summary>
    /// <remarks>
    /// Jellyfin has already called <c>AddSwaggerGen</c> by the time this runs, so the options are
    /// extended rather than reconfigured. Two things then have to be true for a second document to
    /// work at all:
    ///
    /// * Swashbuckle's default inclusion predicate puts *every* action in *every* document, so
    ///   without the predicate below Jellyfin's whole API would appear in StingStream's spec and
    ///   vice versa. The predicate is global, so it also has to keep answering correctly for
    ///   Jellyfin's own "api-docs" document.
    /// * Jellyfin's <c>CachingOpenApiProvider</c> caches on a constant key regardless of which
    ///   document was asked for, which would serve whichever spec was requested first at both
    ///   URLs. That is patched to key on the document name; see <c>docs/PATCHES.md</c>.
    /// </remarks>
    private static void AddStingStreamSwagger(IServiceCollection services)
    {
        services.Configure<SwaggerGenOptions>(options =>
        {
            options.SwaggerDoc(
                StingStreamApi.DocumentName,
                new OpenApiInfo
                {
                    Title = StingStreamApi.Title,
                    Version = StingStreamApi.Version,
                    Description =
                        "StingStream's own API, served from inside this node's Jellyfin. "
                        + "Authentication is Jellyfin's: pass a token as the Authorization header "
                        + "exactly as you would for the Jellyfin API.",
                });

            options.DocInclusionPredicate((documentName, description) =>
            {
                var belongsToStingStream = description.ActionDescriptor is ControllerActionDescriptor controller
                    && controller.ControllerTypeInfo.Assembly == StingStreamCoreMarker.Assembly;

                return string.Equals(documentName, StingStreamApi.DocumentName, StringComparison.Ordinal)
                    ? belongsToStingStream
                    : !belongsToStingStream;
            });
        });
    }

    /// <summary>
    /// Serve the StingStream OpenAPI document.
    /// </summary>
    /// <param name="app">The application builder.</param>
    /// <returns>The application builder, for chaining.</returns>
    /// <remarks>
    /// A second <c>UseSwagger</c> with its own route template. Swashbuckle's template must contain
    /// the <c>{documentName}</c> token, which is why the document is literally named "openapi":
    /// that is what makes the spec land at exactly <c>/stingstream/api/v1/openapi.json</c>.
    /// </remarks>
    public static IApplicationBuilder UseStingStreamCore(this IApplicationBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        app.UseSwagger(options =>
        {
            options.RouteTemplate = StingStreamApi.RouteTemplate;
        });

        return app;
    }
}
