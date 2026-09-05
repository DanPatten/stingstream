using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using StingStream.Core.Arr;

namespace StingStream.Core.Controllers;

/// <summary>
/// Quality profiles, shared across Radarr and Sonarr.
/// </summary>
/// <remarks>
/// The design decision <c>docs/UI-API-GAPS.md</c> gap 4 deferred, taken: a profile is one thing
/// with one name, written into both apps. See <see cref="QualityProfileService"/> for what that
/// costs where the two apps' quality vocabularies differ, and how that difference is reported
/// rather than hidden.
/// </remarks>
[Authorize(Policy = Policies.RequiresElevation)]
[Route("stingstream/api/v1/qualityprofiles")]
public sealed class QualityProfilesController : StingStreamControllerBase
{
    private readonly QualityProfileService _profiles;

    public QualityProfilesController(QualityProfileService profiles)
    {
        _profiles = profiles;
    }

    /// <summary>Every quality profile either app has, merged by name.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The profiles.</response>
    /// <returns>The profiles.</returns>
    [HttpGet(Name = "GetQualityProfiles")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<List<QualityProfileView>>> Get(CancellationToken cancellationToken)
        => await _profiles.ListAsync(cancellationToken).ConfigureAwait(false);

    /// <summary>
    /// What qualities each app understands.
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The vocabulary, per app and shared.</response>
    /// <returns>The vocabulary.</returns>
    /// <remarks>
    /// A profile editor needs this to offer real choices: the names are the app's own, in the app's
    /// own order (best first), and <c>shared</c> is the subset both apps have — the safe set for a
    /// profile meant to govern films and series alike.
    /// </remarks>
    [HttpGet("schema", Name = "GetQualityVocabulary")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<QualityVocabulary>> Schema(CancellationToken cancellationToken)
        => await _profiles.VocabularyAsync(cancellationToken).ConfigureAwait(false);

    /// <summary>One profile by name.</summary>
    /// <param name="name">The profile's name.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The profile.</response>
    /// <response code="404">No app has a profile by that name.</response>
    /// <returns>The profile.</returns>
    [HttpGet("{name}", Name = "GetQualityProfile")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<QualityProfileView>> GetOne(string name, CancellationToken cancellationToken)
    {
        var profile = await _profiles.GetAsync(name, cancellationToken).ConfigureAwait(false);
        return profile is null
            ? NotFound(new { error = $"No quality profile called \"{name}\"." })
            : Ok(profile);
    }

    /// <summary>Create a profile in both apps.</summary>
    /// <param name="profile">The profile.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The profile as the apps stored it.</response>
    /// <response code="400">The profile is unnamed, allows nothing, or an app refused it.</response>
    /// <response code="409">A profile by that name already exists.</response>
    /// <returns>The result.</returns>
    [HttpPost(Name = "CreateQualityProfile")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<QualityProfileWriteResult>> Create(
        [FromBody] QualityProfileView profile,
        CancellationToken cancellationToken)
    {
        if (profile is null || string.IsNullOrWhiteSpace(profile.Name))
        {
            return BadRequest(new { error = "A quality profile needs a name." });
        }

        var existing = await _profiles.GetAsync(profile.Name, cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            return Conflict(new { error = $"A quality profile called \"{profile.Name}\" already exists." });
        }

        var result = await _profiles.SaveAsync(profile, mustExist: false, cancellationToken).ConfigureAwait(false);
        return result.Ok ? Ok(result) : BadRequest(result);
    }

    /// <summary>Replace a profile in both apps.</summary>
    /// <param name="name">The profile's current name.</param>
    /// <param name="profile">The profile.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The profile as the apps stored it.</response>
    /// <response code="400">The profile allows nothing, or an app refused it.</response>
    /// <response code="404">No app has a profile by that name.</response>
    /// <returns>The result.</returns>
    /// <remarks>
    /// Renaming is deliberately not supported here: the name is the profile's identity across two
    /// apps, and a rename that succeeded in one and failed in the other would leave the group with
    /// two half-profiles and no way to tell which was which. Create the new one and delete the old.
    /// </remarks>
    [HttpPut("{name}", Name = "UpdateQualityProfile")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<QualityProfileWriteResult>> Update(
        string name,
        [FromBody] QualityProfileView profile,
        CancellationToken cancellationToken)
    {
        if (profile is null)
        {
            return BadRequest(new { error = "A body is required." });
        }

        profile.Name = name;
        var result = await _profiles.SaveAsync(profile, mustExist: true, cancellationToken).ConfigureAwait(false);
        if (result.Ok)
        {
            return Ok(result);
        }

        return result.Message.StartsWith("No app has", System.StringComparison.Ordinal)
            ? NotFound(result)
            : BadRequest(result);
    }

    /// <summary>Remove a profile from both apps.</summary>
    /// <param name="name">The profile's name.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">What each app did.</response>
    /// <response code="400">An app refused, usually because the profile is still in use.</response>
    /// <response code="404">No app has a profile by that name.</response>
    /// <returns>The result.</returns>
    [HttpDelete("{name}", Name = "DeleteQualityProfile")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<QualityProfileWriteResult>> Delete(
        string name,
        CancellationToken cancellationToken)
    {
        var result = await _profiles.DeleteAsync(name, cancellationToken).ConfigureAwait(false);
        if (result.Ok && string.IsNullOrEmpty(result.Message))
        {
            return Ok(result);
        }

        return result.Ok ? BadRequest(result) : NotFound(result);
    }
}
