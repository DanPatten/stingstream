using System;
using Microsoft.AspNetCore.Mvc;

namespace StingStream.Core.Controllers;

/// <summary>
/// Base for every StingStream API controller.
/// </summary>
/// <remarks>
/// Deliberately not derived from Jellyfin's own <c>BaseJellyfinApiController</c>: that type carries
/// a <c>[Produces]</c> list including Jellyfin's PascalCase media types, which exists for
/// compatibility with a decade of Jellyfin clients and has no business shaping a brand-new API.
/// StingStream's own API is plain camelCase JSON.
///
/// The route prefix is fixed here so every controller agrees on it. Note that Jellyfin maps its
/// whole pipeline under its configured <c>BaseUrl</c>, so on a supervisor-run node these routes are
/// really served at <c>/jellyfin/stingstream/api/v1/...</c>, and the gateway rewrites
/// <c>/stingstream/...</c> onto that.
/// </remarks>
[ApiController]
[Route("stingstream/api/v1/[controller]")]
[Produces("application/json")]
[ApiExplorerSettings(GroupName = StingStreamApi.DocumentName)]
public abstract class StingStreamControllerBase : ControllerBase
{
    /// <summary>
    /// The claim Jellyfin's own authentication handler puts the user id in.
    /// </summary>
    /// <remarks>
    /// The literal string rather than <c>Jellyfin.Api.Constants.InternalClaimTypes.UserId</c>:
    /// that constant lives in <c>Jellyfin.Api</c>, which this project deliberately does not
    /// reference — StingStream's controllers are hosted alongside Jellyfin's, not derived from
    /// them. The value is part of Jellyfin's own token format and changing it would break every
    /// existing client, so copying it is safe in a way that copying an implementation detail
    /// would not be.
    /// </remarks>
    protected const string UserIdClaim = "Jellyfin-UserId";

    /// <summary>The authenticated user's id, or an empty string for an API-key caller.</summary>
    /// <returns>The user id as Jellyfin issued it.</returns>
    protected string CurrentUserId() => User?.FindFirst(UserIdClaim)?.Value ?? string.Empty;

    /// <summary>Whether the caller holds Jellyfin's administrator role.</summary>
    /// <returns>True for an administrator, and for any API key.</returns>
    /// <remarks>
    /// True for an API key as well as for a human administrator: Jellyfin's own authentication
    /// handler stamps <c>role = Administrator</c> on every API-key request. That is Jellyfin's
    /// decision rather than ours, and it is the reason an API key is a full-power credential on
    /// this API too, which <c>docs/SECURITY.md</c> spells out.
    /// </remarks>
    protected bool IsAdministrator() => User?.IsInRole("Administrator") ?? false;

    /// <summary>Whether a user id names the caller.</summary>
    /// <param name="userId">A user id from a route, a query string or a stored row.</param>
    /// <returns>True when it is the caller's own id.</returns>
    /// <remarks>
    /// <para>
    /// Compared as parsed GUIDs, not as strings. Jellyfin issues the same id in <c>N</c> format in
    /// some responses and <c>D</c> format in others, so an app that passes back whichever it was
    /// given would otherwise be told it is somebody else — and, worse, a *stored* id in one format
    /// compared against a claim in the other silently fails an ownership check that was meant to
    /// pass. This lived on <c>UsersController</c>, correctly, while three other places did a raw
    /// case-insensitive string compare for the same question; it belongs here so there is one
    /// answer.
    /// </para>
    /// <para>
    /// An API-key caller's claim is the all-zeros GUID, which matches no real user, so an API key
    /// is never "self" — it gets what it gets from <see cref="IsAdministrator"/> instead.
    /// </para>
    /// </remarks>
    protected bool IsSelf(string? userId)
        => Guid.TryParse(userId, out var asked)
           && Guid.TryParse(CurrentUserId(), out var caller)
           && !asked.Equals(Guid.Empty)
           && asked.Equals(caller);
}

/// <summary>Constants shared by the StingStream API surface.</summary>
public static class StingStreamApi
{
    /// <summary>
    /// Swagger document name.
    /// </summary>
    /// <remarks>
    /// Literally "openapi", because Swashbuckle's route template must contain the
    /// <c>{documentName}</c> token: naming the document this is what makes the spec land at
    /// exactly <c>/stingstream/api/v1/openapi.json</c> rather than at a URL named after the
    /// document.
    /// </remarks>
    public const string DocumentName = "openapi";

    /// <summary>Title shown in the OpenAPI document.</summary>
    public const string Title = "StingStream API";

    /// <summary>Version shown in the OpenAPI document.</summary>
    public const string Version = "1.0.0";

    /// <summary>Route template that serves the document.</summary>
    public const string RouteTemplate = "stingstream/api/v1/{documentName}.json";
}
