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
        services.AddSingleton<RequestService>();

        // Resolved as both the concrete worker and a hosted service, so the controller's "run a
        // pass now" endpoint drives the same instance the timer does rather than a second copy
        // with its own idea of this node's identity.
        services.AddSingleton<RequestWorker>();
        services.AddHostedService(sp => sp.GetRequiredService<RequestWorker>());

        return services;
    }
}
