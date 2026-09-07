using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using StingStream.Core.SyncPlay;

namespace StingStream.Core.Controllers;

/// <summary>
/// Watch together, across nodes: <c>/stingstream/api/v1/watch</c>.
/// </summary>
/// <remarks>
/// <para>
/// **Within one node there is nothing here to use.** Jellyfin's own SyncPlay already synchronises
/// two people signed in to the same server, and a federated title is an ordinary library item to
/// it, so the app's existing SyncPlay screens work on a peer's film unchanged. This is only for the
/// case Jellyfin cannot reach: two friends on two different nodes.
/// </para>
/// <para>
/// The shape follows from that. A session is created on the node whose user started it; every other
/// node *joins* it and runs its own local SyncPlay group underneath. So the app calls
/// <c>POST /watch</c> once, its friends call <c>POST /watch/{id}/join</c>, and from then on
/// everybody uses the SyncPlay UI they already had.
/// </para>
/// <para>
/// Not behind <c>RequiresElevation</c>, unlike most of this API: watching something together is
/// what an ordinary member does, and an admin-only watch party would be a strange feature. It is
/// still behind Jellyfin's authentication, and a member can only see sessions in groups this node
/// belongs to.
/// </para>
/// <para>
/// The route is spelled out rather than inherited from the base's <c>[controller]</c> token, which
/// every other controller here does too. Routing is case-insensitive, so both spellings always
/// worked — but the *OpenAPI document* is not, and the token had been putting <c>/Watch</c> into it
/// while the app, the harness and `docs/MESH.md` all said <c>/watch</c>. A generated client pins
/// the document's spelling, so the one that ends up in `packages/api-client` should be the one
/// everybody writes.
/// </para>
/// </remarks>
[Authorize]
[Route("stingstream/api/v1/watch")]
public class WatchController : StingStreamControllerBase
{
    private readonly WatchBridge _bridge;
    private readonly IWatchMeshClient _watch;
    private readonly ILogger<WatchController> _logger;

    public WatchController(
        WatchBridge bridge,
        IWatchMeshClient watch,
        ILogger<WatchController> logger)
    {
        _bridge = bridge;
        _watch = watch;
        _logger = logger;
    }

    /// <summary>Every open watch session this node can see.</summary>
    /// <param name="group">The mesh group; omit when this node belongs to exactly one.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The sessions.</response>
    /// <returns>The sessions.</returns>
    [HttpGet(Name = "GetWatchSessions")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<WatchSession>>> List(
        [FromQuery] string? group,
        CancellationToken cancellationToken)
    {
        try
        {
            return Ok(await _bridge.ListAsync(group, cancellationToken).ConfigureAwait(false));
        }
        catch (InvalidOperationException ex)
        {
            return Problem(ex.Message, statusCode: StatusCodes.Status409Conflict);
        }
    }

    /// <summary>One session, and where it is right now.</summary>
    /// <param name="sessionId">The session id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The session.</response>
    /// <response code="404">No such session.</response>
    /// <returns>The session.</returns>
    [HttpGet("{sessionId}", Name = "GetWatchSession")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<WatchSessionView>> Get(
        [FromRoute] string sessionId,
        CancellationToken cancellationToken)
    {
        var view = await _watch.GetAsync(sessionId, cancellationToken).ConfigureAwait(false);
        return view is null ? NotFound() : Ok(view);
    }

    /// <summary>Start a session for an item, with this node leading it.</summary>
    /// <param name="request">What to watch, and where.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The session.</response>
    /// <response code="409">The item has no provider ids, or this node has no group.</response>
    /// <returns>The session.</returns>
    [HttpPost(Name = "StartWatchSession")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<WatchSession>> Start(
        [FromBody] StartWatchRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!Guid.TryParse(request.ItemId, out var itemId))
        {
            return BadRequest("itemId is not a media item id.");
        }

        try
        {
            return Ok(await _bridge.StartAsync(itemId, request.Group, cancellationToken).ConfigureAwait(false));
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogInformation(ex, "Could not start a watch session");
            return Problem(ex.Message, statusCode: StatusCodes.Status409Conflict);
        }
    }

    /// <summary>Join a session another node leads.</summary>
    /// <param name="sessionId">The session id.</param>
    /// <param name="group">The mesh group; omit when this node belongs to exactly one.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The session as the leader holds it.</response>
    /// <response code="409">The session has gone, or this node cannot reach its leader.</response>
    /// <returns>The session.</returns>
    [HttpPost("{sessionId}/join", Name = "JoinWatchSession")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<WatchSession>> Join(
        [FromRoute] string sessionId,
        [FromQuery] string? group,
        CancellationToken cancellationToken)
    {
        try
        {
            return Ok(await _bridge.JoinAsync(sessionId, group, cancellationToken).ConfigureAwait(false));
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogInformation(ex, "Could not join watch session {Session}", sessionId);
            return Problem(ex.Message, statusCode: StatusCodes.Status409Conflict);
        }
    }

    /// <summary>
    /// Seat the bridge in a local SyncPlay group, so this node's own users are carried with it.
    /// </summary>
    /// <param name="sessionId">The mesh session id.</param>
    /// <param name="localGroupId">The Jellyfin SyncPlay group on this node.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Seated, or already seated in that group.</response>
    /// <response code="409">This node is not in that session, or Jellyfin would not seat it.</response>
    /// <returns>No content.</returns>
    /// <remarks>
    /// <para>
    /// Separate from joining because the two happen at different moments: a member joins the
    /// session as soon as they accept the invite, and a *local* SyncPlay group exists only once
    /// somebody on this node actually opens the film. Between the two the bridge still follows the
    /// leader's positions — it simply has nothing local to drive yet.
    /// </para>
    /// <para>
    /// **Idempotent.** Seating a bridge that is already seated in the same group answers
    /// <c>204</c>, not a conflict: a retried request whose answer was never seen, and a second
    /// person on this node opening the same film, both land here and neither is an error.
    /// </para>
    /// <para>
    /// A <c>409</c> carries the reason in its <c>detail</c>, and it is logged. That is not
    /// decoration: the one time this failed in CI the whole record of it was the string "409
    /// (Conflict)", which named none of the three quite different things that produce one.
    /// </para>
    /// </remarks>
    [HttpPost("{sessionId}/attach", Name = "AttachWatchSession")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult> Attach(
        [FromRoute] string sessionId,
        [FromQuery] Guid localGroupId,
        CancellationToken cancellationToken)
    {
        try
        {
            await _bridge.AttachAsync(sessionId, localGroupId, cancellationToken).ConfigureAwait(false);
            return NoContent();
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(
                ex,
                "Could not seat the watch bridge for session {Session} in SyncPlay group {Group}",
                sessionId,
                localGroupId);
            return Problem(
                ex.Message,
                statusCode: StatusCodes.Status409Conflict,
                title: "The watch bridge could not be seated");
        }
    }

    /// <summary>Leave a session; if this node leads it, end it for everybody.</summary>
    /// <param name="sessionId">The session id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Left.</response>
    /// <returns>No content.</returns>
    [HttpPost("{sessionId}/leave", Name = "LeaveWatchSession")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<ActionResult> Leave(
        [FromRoute] string sessionId,
        CancellationToken cancellationToken)
    {
        await _bridge.LeaveAsync(sessionId, cancellationToken).ConfigureAwait(false);
        return NoContent();
    }
}
