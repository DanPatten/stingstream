using System;
using Microsoft.Extensions.DependencyInjection;

namespace StingStream.Core.Sharing;

/// <summary>Registers per-link library sharing inside Jellyfin's host.</summary>
/// <remarks>
/// One extension method rather than a line in <c>StingStreamCoreExtensions</c>, following
/// <c>InvitesRegistration</c> and <c>RequestsRegistration</c>: that file is edited by every work
/// package at once, and a one-line addition is one line that can conflict.
/// </remarks>
public static class SharingRegistration
{
    /// <summary>Add the store that answers "which of my libraries does that server get?".</summary>
    /// <param name="services">The service collection.</param>
    /// <returns>The service collection, for chaining.</returns>
    public static IServiceCollection AddStingStreamSharing(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddSingleton<SharedLibraryStore>();
        services.AddSingleton<ISharedLibraries>(sp => sp.GetRequiredService<SharedLibraryStore>());

        return services;
    }
}
