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
/// Quality profiles: StingStream's own list, copied into Radarr and Sonarr by the sync.
/// </summary>
/// <remarks>
/// Every action here reads and writes <see cref="StingStream.Core.Data.SharedSettings.QualityProfiles"/>,
/// so all of them answer at once whether or not a manager is running. See
/// <see cref="QualityProfileService"/> for how the list reaches the managers, and
/// <see cref="BuiltInQualityProfiles"/> for the four every node starts with.
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

    /// <summary>Every quality profile, with which running manager holds a copy of each.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The profiles.</response>
    /// <returns>The profiles.</returns>
    /// <remarks>
    /// Answered from the store. The managers are asked only which of them hold each profile, within
    /// <see cref="QualityProfileService.ReadBudget"/>; one that does not answer in time is left out.
    /// </remarks>
    [HttpGet(Name = "GetQualityProfiles")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<List<QualityProfileView>>> Get(CancellationToken cancellationToken)
        => await _profiles.ListAsync(cancellationToken).ConfigureAwait(false);

    /// <summary>What qualities each app understands.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The vocabulary, per app and shared.</response>
    /// <returns>The vocabulary.</returns>
    [HttpGet("schema", Name = "GetQualityVocabulary")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<QualityVocabulary>> Schema(CancellationToken cancellationToken)
        => await _profiles.VocabularyAsync(cancellationToken).ConfigureAwait(false);

    /// <summary>One profile by name.</summary>
    /// <param name="name">The profile's name.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The profile.</response>
    /// <response code="404">There is no profile by that name.</response>
    /// <returns>The profile.</returns>
    [HttpGet("{name}", Name = "GetQualityProfile")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<QualityProfileView>> GetOne(string name, CancellationToken cancellationToken)
    {
        var profile = await _profiles.GetAsync(name, cancellationToken).ConfigureAwait(false);
        return profile is null
            ? NotFound(new { error = $"There is no quality profile called \"{name}\"." })
            : Ok(profile);
    }

    /// <summary>Create a profile. The managers are given it on the next sync.</summary>
    /// <param name="profile">The profile.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The profile as stored.</response>
    /// <response code="400">The profile is unnamed or allows nothing.</response>
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
            return BadRequest(new { error = "Give the profile a name." });
        }

        profile.Name = profile.Name.Trim();
        await _profiles.EnsureStoreAsync(cancellationToken).ConfigureAwait(false);
        if (_profiles.Find(profile.Name) is not null || BuiltInQualityProfiles.IsBuiltIn(profile.Name))
        {
            return Conflict(new { error = $"A profile called \"{profile.Name}\" already exists." });
        }

        var result = await _profiles.SaveAsync(profile, mustExist: false, cancellationToken).ConfigureAwait(false);
        return result.Ok ? Ok(result) : BadRequest(result);
    }

    /// <summary>Replace a profile. The managers follow on the next sync.</summary>
    /// <param name="name">The profile's current name.</param>
    /// <param name="profile">The profile.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The profile as stored.</response>
    /// <response code="400">The profile allows nothing.</response>
    /// <response code="404">There is no profile by that name.</response>
    /// <returns>The result.</returns>
    /// <remarks>
    /// Renaming is deliberately not supported: the name is the profile's identity inside each
    /// manager, and titles there are filed under it.
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

        return result.NotFound ? NotFound(result) : BadRequest(result);
    }

    /// <summary>Put a built-in profile back the way it shipped.</summary>
    /// <param name="name">Any, High, Medium or Low.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The profile as stored.</response>
    /// <response code="404">The name is not a built-in profile.</response>
    /// <returns>The result.</returns>
    [HttpPost("{name}/reset", Name = "ResetQualityProfile")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<QualityProfileWriteResult>> Reset(
        string name,
        CancellationToken cancellationToken)
    {
        var result = await _profiles.ResetAsync(name, cancellationToken).ConfigureAwait(false);
        if (result.Ok)
        {
            return Ok(result);
        }

        return result.NotFound ? NotFound(result) : BadRequest(result);
    }

    /// <summary>Remove a profile, and retire its name in the managers.</summary>
    /// <param name="name">The profile's name.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">Removed.</response>
    /// <response code="400">A built-in profile, or a running manager has titles on it.</response>
    /// <response code="404">There is no profile by that name.</response>
    /// <returns>The result.</returns>
    [HttpDelete("{name}", Name = "DeleteQualityProfile")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<QualityProfileWriteResult>> Delete(
        string name,
        CancellationToken cancellationToken)
    {
        if (BuiltInQualityProfiles.IsBuiltIn(name))
        {
            return BadRequest(new { error = "Built-in profiles can be reset, not deleted." });
        }

        var result = await _profiles.DeleteAsync(name, cancellationToken).ConfigureAwait(false);
        if (result.Ok)
        {
            return Ok(result);
        }

        // A profile titles are still filed under is a refusal (400) saying what to do; one that
        // was never there is a 404.
        return result.NotFound ? NotFound(result) : BadRequest(result);
    }
}
