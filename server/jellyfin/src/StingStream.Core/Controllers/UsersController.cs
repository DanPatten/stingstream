using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using StingStream.Core.Playback;

namespace StingStream.Core.Controllers;

/// <summary>
/// Per-user StingStream settings. Today that is one: which of speed and quality to favour.
/// </summary>
/// <remarks>
/// A user may always read and write their own policy; changing somebody else's needs elevation.
/// Anonymous access is not possible at all — the route sits behind Jellyfin's own authentication
/// like the rest of the StingStream API.
/// </remarks>
[Authorize]
public sealed class UsersController : StingStreamControllerBase
{
    private readonly PlaybackPolicyStore _policies;

    public UsersController(PlaybackPolicyStore policies)
    {
        _policies = policies;
    }

    /// <summary>What this user would rather have when several nodes hold the same title.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <response code="200">The policy. A user who has never chosen one gets the default.</response>
    /// <response code="403">A non-administrator asked for somebody else's.</response>
    /// <returns>The policy.</returns>
    /// <remarks>
    /// The same self-or-administrator rule the setter has always had. It was missing here, so any
    /// authenticated user could read any other user's stored preference by id. The value is only
    /// speed-versus-quality, so nothing dramatic leaked — but "who else has an account on this
    /// node, and have they configured it" is not a question a member gets to ask, and an
    /// unguarded <c>{userId}</c> read is the shape of a mistake that grows.
    /// </remarks>
    [HttpGet("{userId}/playback-policy")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public ActionResult<UserPlaybackPolicy> GetPlaybackPolicy(string userId)
        => IsSelf(userId) || IsAdministrator()
            ? Ok(_policies.Get(userId))
            : Forbid();

    /// <summary>Choose speed or quality.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <param name="body">The policy.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The stored policy.</response>
    /// <response code="400">The body names neither policy.</response>
    /// <response code="403">A non-administrator tried to change somebody else's.</response>
    /// <returns>The stored policy.</returns>
    [HttpPut("{userId}/playback-policy")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<UserPlaybackPolicy>> SetPlaybackPolicy(
        string userId,
        [FromBody] PlaybackPolicyRequest body,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(body);
        var parsed = PolicyNames.Parse(body.Policy);
        if (parsed is null)
        {
            return BadRequest(new
            {
                error = $"'{body.Policy}' is not a playback policy.",
                allowed = new[] { PolicyNames.SpeedFirst, PolicyNames.QualityFirst },
            });
        }

        if (!IsSelf(userId) && !IsAdministrator())
        {
            return Forbid();
        }

        return Ok(await _policies.SetAsync(userId, parsed.Value, cancellationToken).ConfigureAwait(false));
    }

}

/// <summary>Body of <c>PUT /users/{userId}/playback-policy</c>.</summary>
public sealed class PlaybackPolicyRequest
{
    /// <summary><c>speed_first</c> or <c>quality_first</c>.</summary>
    public string Policy { get; set; } = PolicyNames.SpeedFirst;
}
