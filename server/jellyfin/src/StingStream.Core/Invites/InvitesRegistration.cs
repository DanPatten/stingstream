using System;
using Microsoft.Extensions.DependencyInjection;

namespace StingStream.Core.Invites;

/// <summary>Registers person invites inside Jellyfin's host.</summary>
/// <remarks>
/// One extension method rather than two lines in <c>StingStreamCoreExtensions</c>, following
/// <c>RequestsRegistration</c>: that file is edited by every work package at once, and a one-line
/// addition is one line that can conflict.
/// </remarks>
public static class InvitesRegistration
{
    /// <summary>Add the invite store and the service over it.</summary>
    /// <param name="services">The service collection.</param>
    /// <returns>The service collection, for chaining.</returns>
    public static IServiceCollection AddStingStreamInvites(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddSingleton<InviteStore>();
        services.AddSingleton<InviteService>();

        return services;
    }
}
