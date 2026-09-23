using System;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using StingStream.Core.Downloads;

namespace StingStream.Core.Controllers;

/// <summary>
/// One list of downloads, across both arrs' queues.
/// </summary>
/// <remarks>
/// <c>docs/UI-API-GAPS.md</c> gap 7. Every download is in a client the user runs, and each arr's
/// queue is behind its own generated API key, which Core never hands to a Jellyfin-authenticated
/// caller. So this is Core making the authenticated call and reshaping both queues into one
/// contract.
/// </remarks>
[Authorize(Policy = Policies.RequiresElevation)]
[Route("stingstream/api/v1/downloads")]
public sealed class DownloadsController : StingStreamControllerBase
{
    private readonly DownloadsService _downloads;

    public DownloadsController(DownloadsService downloads)
    {
        _downloads = downloads;
    }

    /// <summary>Every download this node knows about, in one list.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The downloads, plus which engines answered.</response>
    /// <returns>The downloads.</returns>
    [HttpGet(Name = "GetDownloads")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<DownloadsView>> Get(CancellationToken cancellationToken)
        => await _downloads.ListAsync(cancellationToken).ConfigureAwait(false);

    /// <summary>
    /// Remove one download.
    /// </summary>
    /// <param name="engine"><c>radarr</c> or <c>sonarr</c>: the app whose queue holds it.</param>
    /// <param name="id">That app's queue id.</param>
    /// <param name="deleteFiles">Also delete what has been downloaded so far.</param>
    /// <param name="blocklist">Tell the arr never to grab this release again.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">Removed.</response>
    /// <response code="409">No such download, or the app refused.</response>
    /// <returns>What happened.</returns>
    /// <remarks>
    /// The removal goes through the arr, so the queue row goes too. See
    /// <see cref="DownloadsService.RemoveAsync"/>.
    /// </remarks>
    [HttpDelete("{engine}/{id}", Name = "RemoveDownload")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<DownloadActionResult>> Remove(
        string engine,
        string id,
        [FromQuery] bool deleteFiles,
        [FromQuery] bool blocklist,
        CancellationToken cancellationToken)
        => Answer(await _downloads
            .RemoveAsync(engine, id, deleteFiles, blocklist, cancellationToken)
            .ConfigureAwait(false));

    /// <summary>
    /// A refusal is a 409, not a 500.
    /// </summary>
    /// <remarks>
    /// "That download is gone" is a true answer to a well-formed request about the current state
    /// of the node, which is what 409 is for. A 500 would make a UI show a crash dialogue.
    /// </remarks>
    private ActionResult<DownloadActionResult> Answer(DownloadActionResult result)
        => result.Ok ? Ok(result) : Conflict(result);
}
