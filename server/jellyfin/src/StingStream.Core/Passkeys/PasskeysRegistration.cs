using System;
using Microsoft.Extensions.DependencyInjection;

namespace StingStream.Core.Passkeys;

/// <summary>Registers passkeys inside Jellyfin's host.</summary>
/// <remarks>
/// One extension method rather than three lines in <c>StingStreamCoreExtensions</c>, following
/// <c>RequestsRegistration</c> and <c>InvitesRegistration</c>: that file is edited by every work
/// package at once.
/// </remarks>
public static class PasskeysRegistration
{
    /// <summary>Add the passkey store, the in-flight ceremonies and the service over them.</summary>
    /// <param name="services">The service collection.</param>
    /// <returns>The service collection, for chaining.</returns>
    public static IServiceCollection AddStingStreamPasskeys(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddSingleton<PasskeyStore>();
        // A singleton, and it has to be: a ceremony begun on one request is answered on the next,
        // and a scoped instance would forget the challenge in between.
        services.AddSingleton<PasskeyCeremonies>();
        services.AddSingleton<PasskeyService>();

        return services;
    }
}
