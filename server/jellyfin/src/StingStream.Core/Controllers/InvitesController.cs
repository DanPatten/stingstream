using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Controller.Authentication;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using StingStream.Core.Invites;

namespace StingStream.Core.Controllers;

/// <summary>
/// Inviting a person to this server, and the two calls a person who has been invited makes.
/// </summary>
/// <remarks>
/// <para>
/// Three of these routes are an administrator's; two are open to somebody with no account at all,
/// because that is the entire point — an invite is opened, by definition, by a person who cannot
/// sign in yet. The class is behind <c>RequiresElevation</c> and the two anonymous actions opt out
/// individually, so the default is closed and each exception is visible on the action it applies
/// to.
/// </para>
/// <para>
/// <b>The token travels in a request body, never in a path or a query string.</b> The obvious
/// shape for "tell me about this invite" is <c>GET /invites/{token}</c>, and it would write the
/// credential into this server's access log, the gateway's, and any proxy in between — where it
/// would sit for as long as logs are kept, readable by anybody who can read them, and get copied
/// into every support bundle. The link already keeps it out of the wire by carrying it in the URL
/// fragment; posting it keeps it out of the log too. That is why <c>lookup</c> is a <c>POST</c>
/// that changes nothing.
/// </para>
/// <para>
/// Derived from <see cref="ControllerBase"/> rather than from <c>StingStreamControllerBase</c>,
/// exactly as <c>SetupController</c> and <c>WebhooksController</c> are: the base class's
/// <c>[controller]</c> route does not suit routes that sit beside each other under one noun, and
/// re-declaring the four attributes by hand is what keeps these operations in the StingStream
/// OpenAPI document — without <c>[ApiExplorerSettings]</c> they vanish from <c>openapi.json</c> and
/// the generated client silently never learns about them.
/// </para>
/// </remarks>
[ApiController]
[Authorize(Policy = Policies.RequiresElevation)]
[Route("stingstream/api/v1/invites")]
[Produces("application/json")]
[ApiExplorerSettings(GroupName = StingStreamApi.DocumentName)]
public sealed class InvitesController : ControllerBase
{
    private readonly InviteService _invites;
    private readonly ISessionManager _sessions;
    private readonly IAuthorizationContext _authContext;
    private readonly ILogger<InvitesController> _logger;

    public InvitesController(
        InviteService invites,
        ISessionManager sessions,
        IAuthorizationContext authContext,
        ILogger<InvitesController> logger)
    {
        _invites = invites;
        _sessions = sessions;
        _authContext = authContext;
        _logger = logger;
    }

    /// <summary>The libraries an invite can be scoped to.</summary>
    /// <response code="200">Every library on this server.</response>
    /// <returns>The libraries.</returns>
    [HttpGet("libraries", Name = "StingStreamInviteLibraries")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<InviteLibrary>> Libraries() => Ok(_invites.Libraries());

    /// <summary>Every invite this server has minted, newest first.</summary>
    /// <response code="200">The invites.</response>
    /// <returns>The invites.</returns>
    [HttpGet(Name = "StingStreamInvites")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<InviteSummary>> List()
        => Ok(_invites.List(DateTimeOffset.UtcNow));

    /// <summary>Mint an invite.</summary>
    /// <param name="request">The label, the libraries and how long it should last.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The token and the link. This is the only time the token is returned.</response>
    /// <response code="400">The request names no library, or one this server does not have.</response>
    /// <returns>The minted invite.</returns>
    [HttpPost(Name = "StingStreamMintInvite")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(InviteError), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<MintedInvite>> Mint(
        [FromBody] MintInviteRequest request,
        CancellationToken cancellationToken)
    {
        var auth = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        var (minted, problem) = await _invites.MintAsync(
            request ?? new MintInviteRequest(),
            auth.User?.Id.ToString("N") ?? string.Empty,
            auth.User?.Username ?? "An administrator",
            DateTimeOffset.UtcNow,
            cancellationToken).ConfigureAwait(false);

        return problem is not null
            ? BadRequest(new InviteError { Error = problem })
            : Ok(minted);
    }

    /// <summary>The link for an invite that has already been minted.</summary>
    /// <param name="id">The invite id, from the list. Never the token.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The token and the link.</response>
    /// <response code="404">No such invite, or it has been used and its token is gone.</response>
    /// <returns>The invite, as minting returned it.</returns>
    /// <remarks>
    /// <para>
    /// Dan: <em>"allow the user to re-open the existing invite to get the url again"</em>. Losing
    /// the one copy of a link is an ordinary thing to do, and the answer used to be "mint another",
    /// which leaves a dead link in somebody else's chat.
    /// </para>
    /// <para>
    /// Administrator only, like minting, and addressed by the invite's id rather than by its token
    /// — so asking for a link never means already holding one. A redeemed invite answers 404: its
    /// token is cleared when the account is created, and there is nothing left to show.
    /// </para>
    /// </remarks>
    [HttpGet("{id}/link", Name = "StingStreamInviteLink")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<MintedInvite>> Link(
        string id,
        CancellationToken cancellationToken)
    {
        var minted = await _invites.LinkAsync(id, cancellationToken).ConfigureAwait(false);
        return minted is null ? NotFound() : Ok(minted);
    }

    /// <summary>Delete an invite.</summary>
    /// <param name="id">The invite id, from the list. Never the token.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Deleted.</response>
    /// <response code="404">No such invite, or it was already gone.</response>
    /// <returns>Nothing.</returns>
    /// <remarks>
    /// <para>
    /// The row is deleted rather than marked withdrawn. Dan: <em>"When deleteing an invite dont say
    /// withdrawn - just delete it."</em> — and the list stopped being the record of who has access
    /// in the same breath, because the Sharing screen reads People from the accounts on this server
    /// now.
    /// </para>
    /// <para>
    /// An account the invite already created is not touched — that account is a person, and
    /// removing their access is a separate decision made on the Users screen.
    /// </para>
    /// </remarks>
    [HttpDelete("{id}", Name = "StingStreamDeleteInvite")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> Delete(string id, CancellationToken cancellationToken)
        => await _invites.DeleteAsync(id, cancellationToken).ConfigureAwait(false)
            ? NoContent()
            : NotFound();

    /// <summary>What this invite is, for the page somebody lands on after opening a link.</summary>
    /// <param name="request">The token out of the link's fragment.</param>
    /// <response code="200">The server, who invited them, and what they will be able to watch.</response>
    /// <response code="404">No invite has ever had this token.</response>
    /// <response code="410">There was one, and it cannot be used: the sentence says why.</response>
    /// <returns>The description.</returns>
    /// <remarks>
    /// <para>
    /// Anonymous, and it has to be: the person reading it has no account, which is the reason they
    /// were sent a link.
    /// </para>
    /// <para>
    /// A spent, expired or withdrawn invite gets <c>410</c> and a sentence rather than the
    /// <c>404</c> a token that never existed gets. Distinguishing the two tells a prober nothing
    /// they could use — learning that a particular 256-bit string was once an invite requires
    /// already holding that string, and whoever holds it is the person the link was sent to. What
    /// it buys is the difference between "ask them for a new one" and a dead end.
    /// </para>
    /// </remarks>
    [HttpPost("lookup", Name = "StingStreamLookupInvite")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(InviteError), StatusCodes.Status410Gone)]
    public ActionResult<InviteDescription> Lookup([FromBody] InviteTokenRequest request)
    {
        var (status, row) = _invites.Lookup(request?.Token, DateTimeOffset.UtcNow);
        if (row is null)
        {
            return NotFound();
        }

        if (status != InviteStatus.Valid)
        {
            return StatusCode(
                StatusCodes.Status410Gone,
                new InviteError { Error = InviteGate.Explain(status)! });
        }

        return Ok(_invites.Describe(row));
    }

    /// <summary>Create the account this invite is for.</summary>
    /// <param name="request">The token, and the name and password they chose.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The account exists, and here is a session for it.</response>
    /// <response code="400">The name or the password is not usable; the sentence says which.</response>
    /// <response code="404">No invite has ever had this token.</response>
    /// <response code="410">There was one, and it cannot be used.</response>
    /// <returns>A signed-in session, exactly as signing in would have produced.</returns>
    /// <remarks>
    /// The answer is a sign-in, so the app moves straight to the library rather than showing a login
    /// form to somebody who has just chosen a password. <c>AuthenticateNewSession</c> rather than
    /// <c>AuthenticateDirect</c>: the password was typed here a moment ago and verifying it is
    /// nearly free, so the session is issued by the same path every other sign-in takes.
    /// </remarks>
    [HttpPost("accept", Name = "StingStreamAcceptInvite")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(InviteError), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(InviteError), StatusCodes.Status410Gone)]
    public async Task<ActionResult<AuthenticationResult>> Accept(
        [FromBody] AcceptInviteRequest request,
        CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var (status, row) = _invites.Lookup(request?.Token, now);
        if (row is null)
        {
            return NotFound();
        }

        if (status != InviteStatus.Valid)
        {
            return StatusCode(
                StatusCodes.Status410Gone,
                new InviteError { Error = InviteGate.Explain(status)! });
        }

        var (username, problem) = await _invites.AcceptAsync(
            row,
            request!.Username,
            request.Password,
            now,
            cancellationToken).ConfigureAwait(false);

        if (problem is not null)
        {
            return BadRequest(new InviteError { Error = problem });
        }

        var auth = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        var result = await _sessions.AuthenticateNewSession(new AuthenticationRequest
        {
            // The four identity fields are required, and somebody redeeming an invite in a browser
            // may legitimately have sent none of them -- this is the first request they ever make.
            App = Fallback(auth.Client, "StingStream"),
            AppVersion = Fallback(auth.Version, StingStreamApi.Version),
            DeviceId = Fallback(auth.DeviceId, "stingstream-invite"),
            DeviceName = Fallback(auth.Device, "Invite"),
            Password = request.Password,
            RemoteEndPoint = HttpContext.GetNormalizedRemoteIP().ToString(),
            Username = username,
        }).ConfigureAwait(false);

        _logger.LogInformation("An invite was redeemed as {Username}", username);
        return result;
    }

    private static string Fallback(string? value, string fallback)
        => string.IsNullOrWhiteSpace(value) ? fallback : value;
}
