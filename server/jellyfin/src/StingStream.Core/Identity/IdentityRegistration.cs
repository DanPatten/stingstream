using System;
using Microsoft.Extensions.DependencyInjection;

namespace StingStream.Core.Identity;

/// <summary>Registers cross-server sign-in inside Jellyfin's host.</summary>
/// <remarks>
/// One extension method rather than three lines in <c>StingStreamCoreExtensions</c>, following
/// <c>InvitesRegistration</c> and <c>RequestsRegistration</c>: that file is edited by every work
/// package at once, and a one-line addition is one line that can conflict.
/// </remarks>
public static class IdentityRegistration
{
    /// <summary>Add the link store, the challenges and the service over them.</summary>
    /// <param name="services">The service collection.</param>
    /// <returns>The service collection, for chaining.</returns>
    public static IServiceCollection AddStingStreamIdentity(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddSingleton<IdentityStore>();
        // A singleton because the challenges live in it: a scoped one would forget every nonce
        // between the request that issued it and the request that answers it.
        services.AddSingleton<IdentityChallenges>();
        services.AddSingleton<IdentityService>();

        return services;
    }
}
