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
