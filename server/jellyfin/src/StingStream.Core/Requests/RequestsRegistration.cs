using System;
using Microsoft.Extensions.DependencyInjection;

namespace StingStream.Core.Requests;

/// <summary>Registers M6's services inside Jellyfin's host.</summary>
/// <remarks>
/// One extension method rather than eight lines in <c>StingStreamCoreExtensions</c>, so M6's
/// footprint in that shared file is a single call. The checkout is shared and that file is edited by
/// every work package at once; a one-line addition is one line that can conflict.
/// </remarks>
public static class RequestsRegistration
{
    /// <summary>Add the requests service, its store, its notifier and its fulfilment worker.</summary>
    /// <param name="services">The service collection.</param>
    /// <returns>The service collection, for chaining.</returns>
    public static IServiceCollection AddStingStreamRequests(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddSingleton<RequestStore>();
        services.AddSingleton<IRequestMesh, RequestMesh>();
        services.AddSingleton<RequestNotifier>();

        // Posters for the series TVDB has no artwork for. Short timeout by design: this runs on the
        // search path, and a slow answer must cost a placeholder tile rather than a slow search.
        // ArtworkFallback caps each call again on its own, so this is only the outer bound.
        services.AddHttpClient(ArtworkFallback.HttpClientName, client =>
        {
            client.Timeout = TimeSpan.FromSeconds(5);
            // TVmaze asks for a real user agent and rate limits harder without one.
            client.DefaultRequestHeaders.UserAgent.ParseAdd("StingStream/1.0");
        });
        services.AddSingleton<ArtworkFallback>();

        // The catalogue behind the Find screen. Longer timeout than the artwork fallback: this one
        // is the screen rather than a detail on it, and a feed is several calls deep. TmdbCatalog
        // caps each call and the whole pass again on its own, so this is only the outer bound.
        services.AddHttpClient(TmdbCatalog.HttpClientName, client =>
        {
            client.Timeout = TimeSpan.FromSeconds(10);
            client.DefaultRequestHeaders.UserAgent.ParseAdd("StingStream/1.0");
        });
        services.AddSingleton<TmdbCatalog>();
        services.AddSingleton<RequestService>();

        // Withdrawing, which is the delete path and the download it has to stop. Shared by the
        // controller (the person pressing Delete) and the worker (the volunteer hearing about it).
        services.AddSingleton<RequestWithdrawal>();

        // Resolved as both the concrete worker and a hosted service, so the controller's "run a
        // pass now" endpoint drives the same instance the timer does rather than a second copy
        // with its own idea of this node's identity.
        services.AddSingleton<RequestWorker>();
        services.AddHostedService(sp => sp.GetRequiredService<RequestWorker>());

        return services;
    }
}
