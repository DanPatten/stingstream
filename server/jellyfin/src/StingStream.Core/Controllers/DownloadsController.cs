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
/// One list of downloads, whichever engine is really carrying each.
/// </summary>
/// <remarks>
/// <c>docs/UI-API-GAPS.md</c> gap 7. The pieces already worked and already talked to each other —
/// the qBittorrent shim, NZBGet's JSON-RPC, the arrs' queues — but each behind its own generated
/// credentials, which Core never handed to a Jellyfin-authenticated caller and should not. So this
/// is Core doing the authenticated call to whichever engine and re-shaping all three into one
/// contract: the same pattern the qBittorrent shim uses to make MonoTorrent look like qBittorrent
/// to the arrs, pointed the other way.
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

    /// <summary>Pause one download.</summary>
    /// <param name="engine"><c>torrent</c> or <c>usenet</c>.</param>
    /// <param name="id">The engine's own id: an info hash, or an NZBID.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">Paused.</response>
    /// <response code="409">This engine cannot pause: it tracks the download rather than holding it.</response>
    /// <returns>What happened.</returns>
    [HttpPost("{engine}/{id}/pause", Name = "PauseDownload")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<DownloadActionResult>> Pause(
        string engine,
        string id,
        CancellationToken cancellationToken)
        => Answer(await _downloads.PauseAsync(engine, id, cancellationToken).ConfigureAwait(false));

    /// <summary>Resume one download.</summary>
    /// <param name="engine"><c>torrent</c> or <c>usenet</c>.</param>
    /// <param name="id">The engine's own id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">Resumed.</response>
    /// <response code="409">This engine cannot resume.</response>
    /// <returns>What happened.</returns>
    [HttpPost("{engine}/{id}/resume", Name = "ResumeDownload")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<DownloadActionResult>> Resume(
        string engine,
        string id,
        CancellationToken cancellationToken)
        => Answer(await _downloads.ResumeAsync(engine, id, cancellationToken).ConfigureAwait(false));

    /// <summary>
    /// Remove one download.
    /// </summary>
    /// <param name="engine"><c>torrent</c>, <c>usenet</c>, <c>radarr</c> or <c>sonarr</c>.</param>
    /// <param name="id">The engine's own id.</param>
    /// <param name="deleteFiles">Also delete what has been downloaded so far.</param>
    /// <param name="blocklist">Tell the arr never to grab this release again.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">Removed.</response>
    /// <response code="409">No such download, or the engine refused.</response>
    /// <returns>What happened.</returns>
    /// <remarks>
    /// When an arr is waiting for the download, the removal goes through that arr with
    /// <c>removeFromClient=true</c>, so the queue row goes too — see
    /// <see cref="DownloadsService.RemoveAsync"/> for why doing it the other way round produces a
    /// failed-grab notification a few minutes later.
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
    /// "This engine cannot pause" and "that download is gone" are both true answers to a
    /// well-formed request about the current state of the node, which is what 409 is for. A 500
    /// would make a UI show a crash dialogue for a button that is simply not applicable.
    /// </remarks>
    private ActionResult<DownloadActionResult> Answer(DownloadActionResult result)
        => result.Ok ? Ok(result) : Conflict(result);
}
