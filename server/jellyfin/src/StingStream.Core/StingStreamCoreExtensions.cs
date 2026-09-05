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
using StingStream.Core.FirstRun;
using StingStream.Core.Inventory;
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

        // Torrents. Registered once and resolved as both the concrete engine and a hosted service,
        // so the qBittorrent shim and the lifecycle share one instance.
        services.AddSingleton<TorrentEngine>();
        services.AddHostedService(sp => sp.GetRequiredService<TorrentEngine>());
        services.AddSingleton<QbtSessionStore>();

        // Inventory and hashing.
        services.AddSingleton<IIdleSignal, SessionIdleSignal>();
        services.AddSingleton<HashingService>();
        services.AddHostedService(sp => sp.GetRequiredService<HashingService>());
        services.AddSingleton<IInventoryService, InventoryService>();

        // Webhooks.
        services.AddSingleton<ArrWebhookService>();

        // First-run wiring, last so everything it needs already exists.
        services.AddSingleton<FirstRunService>();
        services.AddHostedService(sp => sp.GetRequiredService<FirstRunService>());

        AddStingStreamSwagger(services);

        return services;
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
