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
