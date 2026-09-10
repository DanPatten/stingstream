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
using StingStream.Core.Identity;

namespace StingStream.Core.Controllers;

/// <summary>
/// Signing in here with an account you hold on your own server.
/// </summary>
/// <remarks>
/// <para>
/// Five routes with three different audiences, which is why the default is closed and each
/// exception is declared on the action it applies to:
/// </para>
/// <list type="bullet">
/// <item><c>challenge</c> and <c>signin</c> are <b>anonymous</b>, because somebody signing in has
/// no session here yet — that is the whole point.</item>
/// <item><c>vouch</c> needs a <b>session on this server</b>. It is the other half of the flow: this
/// is the endpoint <em>your own</em> server exposes when you are the one signing in
/// elsewhere.</item>
/// <item><c>links</c> is an <b>administrator's</b> list of which remote identities hold accounts
/// here, and the way to end one.</item>
/// </list>
/// <para>
/// <b>Nothing here is a credential in a URL.</b> The assertion and the nonce both ride in request
/// bodies, for the reason <c>InvitesController</c> gives at length: a path or query string is
/// written into this server's access log, the gateway's, and every proxy in between.
/// </para>
/// <para>
/// Derived from <see cref="ControllerBase"/> with the four attributes re-declared by hand, exactly
/// as <c>InvitesController</c>, <c>SetupController</c> and <c>PasskeysController</c> are — without
/// <c>[ApiExplorerSettings]</c> these operations vanish from <c>openapi.json</c> and the generated
/// client silently never learns about them.
/// </para>
/// </remarks>
[ApiController]
[Authorize]
[Route("stingstream/api/v1/identity")]
[Produces("application/json")]
[ApiExplorerSettings(GroupName = StingStreamApi.DocumentName)]
public sealed class IdentityController : ControllerBase
{
    private readonly IdentityService _identity;
    private readonly ISessionManager _sessions;
    private readonly IAuthorizationContext _authContext;
    private readonly ILogger<IdentityController> _logger;

    public IdentityController(
        IdentityService identity,
        ISessionManager sessions,
        IAuthorizationContext authContext,
        ILogger<IdentityController> logger)
    {
        _identity = identity;
        _sessions = sessions;
        _authContext = authContext;
        _logger = logger;
    }

    /// <summary>Ask this server for a nonce to have your own server sign.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The nonce, this node's id, and how long it lasts.</response>
    /// <response code="503">This node has no id yet, or too many challenges are outstanding.</response>
    /// <returns>The challenge.</returns>
    /// <remarks>
    /// Anonymous, and it reveals this node's id and friendly name — both of which anybody who can
    /// reach the gateway already learns from <c>/sidedoor/v1/hello</c>. What it does not do is say
    /// anything about who has an account here.
    /// </remarks>
    [HttpPost("challenge", Name = "StingStreamIdentityChallenge")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<IdentityChallengeResponse>> Challenge(
        CancellationToken cancellationToken)
    {
        var challenge = await _identity
            .ChallengeAsync(DateTimeOffset.UtcNow, cancellationToken)
            .ConfigureAwait(false);

        return challenge is null
            ? StatusCode(StatusCodes.Status503ServiceUnavailable)
            : Ok(challenge);
    }

    /// <summary>Have this server sign a statement about you, for another server.</summary>
    /// <param name="request">The other server's node id and nonce.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The assertion.</response>
    /// <response code="400">The request was incomplete, or the mesh could not sign it.</response>
    /// <returns>The assertion.</returns>
    /// <remarks>
    /// <b>Any member, not an administrator.</b> What this produces is a statement about the caller
    /// themselves, usable only at the one audience named in it. Vouching for yourself to somebody
    /// else's server tells that server who you are and gives it nothing else — and restricting it
    /// to administrators would mean only administrators could ever hold an account elsewhere, which
    /// is the opposite of the point.
    /// </remarks>
    [HttpPost("vouch", Name = "StingStreamIdentityVouch")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(IdentityError), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<VouchResponse>> Vouch(
        [FromBody] VouchRequest request,
        CancellationToken cancellationToken)
    {
        var userId = User?.FindFirst("Jellyfin-UserId")?.Value ?? string.Empty;
        var userName = User?.Identity?.Name ?? string.Empty;
        if (string.IsNullOrEmpty(userId))
        {
            return BadRequest(new IdentityError { Error = "Sign in first." });
        }

        var (vouch, problem) = await _identity.VouchAsync(
            userId,
            userName,
            request?.Audience,
            request?.Nonce,
            cancellationToken).ConfigureAwait(false);

        return problem is not null
            ? BadRequest(new IdentityError { Error = problem })
            : Ok(vouch!);
    }

    /// <summary>Sign in with an assertion your own server made.</summary>
    /// <param name="request">The assertion, and an invite token the first time.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">A session, exactly as a password sign-in produces.</response>
    /// <response code="401">It could not be used, and why.</response>
    /// <returns>The session.</returns>
    /// <remarks>
    /// Ends at <c>AuthenticateDirect</c> rather than <c>AuthenticateNewSession</c>, the same as the
    /// passkey route: there is no password to check, because the proof already happened when the
    /// other server signed the assertion. The password the account ends up with was derived on the
    /// caller's own origin and arrives already derived, so there is nothing here to check it
    /// against and nothing here that has ever seen the password itself.
    /// </remarks>
    [HttpPost("signin", Name = "StingStreamIdentitySignIn")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(IdentityError), StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<AuthenticationResult>> SignIn(
        [FromBody] IdentitySignInRequest request,
        CancellationToken cancellationToken)
    {
        var (user, problem) = await _identity.SignInAsync(
            request?.Assertion,
            request?.InviteToken,
            DateTimeOffset.UtcNow,
            cancellationToken,
            request?.RequestLink ?? false,
            IdentityGate.ReadCredential(
                request?.Salt,
                request?.Verifier,
                request?.Iterations)).ConfigureAwait(false);

        if (user is null)
        {
            return Unauthorized(new IdentityError
            {
                Error = problem ?? "That sign-in could not be used.",
            });
        }

        var auth = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        var result = await _sessions.AuthenticateDirect(new AuthenticationRequest
        {
            UserId = user.Id,
            Username = user.Username,
            // The four identity fields are required, and a browser doing this on its first ever
            // request to this server may legitimately have sent none of them.
            App = Fallback(auth.Client, "StingStream"),
            AppVersion = Fallback(auth.Version, StingStreamApi.Version),
            DeviceId = Fallback(auth.DeviceId, "stingstream-identity"),
            DeviceName = Fallback(auth.Device, "Another server"),
            RemoteEndPoint = HttpContext.GetNormalizedRemoteIP().ToString(),
        }).ConfigureAwait(false);

        _logger.LogInformation("{User} signed in from another server", user.Username);
        return result;
    }

    /// <summary>How to send a password for one username.</summary>
    /// <param name="request">The username.</param>
    /// <response code="200">What to send. Never whether the username exists.</response>
    /// <returns>The method.</returns>
    /// <remarks>
    /// <b>Anonymous, because the caller is by definition somebody who has not signed in yet.</b>
    /// An account that arrived from another server signs in with a value derived from its password
    /// rather than the password itself, and its client cannot derive that without the salt — so the
    /// salt has to be gettable without a session. It is not a secret; what it buys is that one
    /// server's derived password is useless on another.
    /// <para>
    /// A username nobody holds, an ordinary account and a linked account whose password has been
    /// reset all answer identically, so this is not a way to find out who has an account here.
    /// What it does tell somebody already holding a username is that it came from elsewhere.
    /// </para>
    /// </remarks>
    [HttpPost("signin-method", Name = "StingStreamSignInMethod")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<SignInMethodResponse> SignInMethod(
        [FromBody] SignInMethodRequest request)
        => Ok(_identity.DescribeSignIn(request?.Username));

    /// <summary>Set the password you use on this server.</summary>
    /// <param name="request">The salt, the derived password and the round count.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">It is set.</response>
    /// <response code="400">The request was incomplete, or this is not a linked account.</response>
    /// <returns>Nothing.</returns>
    /// <remarks>
    /// For somebody whose account came from another server and who has since changed their password
    /// there: the two are no longer in step, and this is what puts them back without needing an
    /// administrator. <b>What arrives is the derived value and never the password</b>, the same rule
    /// as the sign-in itself.
    /// <para>
    /// Always the caller's own account, read from the session rather than from the body — a user id
    /// somebody typed is a user id somebody chose.
    /// </para>
    /// </remarks>
    [HttpPost("password", Name = "StingStreamSetLinkedPassword")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(IdentityError), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult> SetPassword(
        [FromBody] SetLinkedPasswordRequest request,
        CancellationToken cancellationToken)
    {
        var userId = User?.FindFirst("Jellyfin-UserId")?.Value ?? string.Empty;
        if (string.IsNullOrEmpty(userId))
        {
            return BadRequest(new IdentityError { Error = "Sign in first." });
        }

        var credential = IdentityGate.ReadCredential(
            request?.Salt,
            request?.Verifier,
            request?.Iterations);
        if (credential is null)
        {
            return BadRequest(new IdentityError { Error = "That password could not be used." });
        }

        var problem = await _identity
            .SetDerivedPasswordAsync(userId, credential.Value, cancellationToken)
            .ConfigureAwait(false);

        return problem is null
            ? NoContent()
            : BadRequest(new IdentityError { Error = problem });
    }

    /// <summary>Make a linked account sign in with an ordinary password again.</summary>
    /// <param name="request">The account whose password was just reset.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Done, or there was nothing to do.</response>
    /// <returns>Nothing.</returns>
    /// <remarks>
    /// Called by the Users screen straight after an administrator resets somebody's password.
    /// Jellyfin now holds a hash of what they typed, so a client still deriving against the old
    /// salt would send something that cannot match — and Jellyfin locks an account after three of
    /// those. Clearing it is what makes the reset a way in rather than a way out.
    /// <para>
    /// Administrator, because resetting a password is, and a no-op for an ordinary account.
    /// </para>
    /// </remarks>
    [HttpPost("password/derivation/clear", Name = "StingStreamClearPasswordDerivation")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<ActionResult> ClearDerivation(
        [FromBody] ClearDerivationRequest request,
        CancellationToken cancellationToken)
    {
        await _identity
            .ClearDerivedPasswordAsync(request?.UserId ?? string.Empty, cancellationToken)
            .ConfigureAwait(false);
        return NoContent();
    }

    /// <summary>Ask for the server you run to be linked with this one.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">There is now a request.</response>
    /// <response code="400">This account did not arrive from another server, so there is none to link.</response>
    /// <returns>Nothing.</returns>
    /// <remarks>
    /// Any member — asking is not deciding. The node being asked about is read from the caller's
    /// own link row, never from the request: what a link holds was proved by a signature, and a
    /// node id somebody typed is a node id somebody chose.
    /// </remarks>
    [HttpPost("link-requests", Name = "StingStreamRequestLink")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(IdentityError), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult> RequestLink(CancellationToken cancellationToken)
    {
        var userId = User?.FindFirst("Jellyfin-UserId")?.Value ?? string.Empty;
        var made = await _identity
            .RequestLinkAsync(userId, DateTimeOffset.UtcNow, cancellationToken)
            .ConfigureAwait(false);

        return made
            ? NoContent()
            : BadRequest(new IdentityError
            {
                Error = "This account did not come from another server, so there is none to link.",
            });
    }

    /// <summary>What this account's own link request is doing.</summary>
    /// <response code="200">The status, and the invite once it is approved.</response>
    /// <returns>The request.</returns>
    /// <remarks>
    /// Scoped to the caller inside the service rather than by a check in front of it, the way the
    /// passkey routes scope credentials: the only request it can ever describe is the one belonging
    /// to the server the caller signed in from.
    /// </remarks>
    [HttpGet("link-requests/mine", Name = "StingStreamMyLinkRequest")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<MyLinkRequest> MyLinkRequest()
        => Ok(_identity.MyRequest(User?.FindFirst("Jellyfin-UserId")?.Value ?? string.Empty));

    /// <summary>Which servers have asked to be linked with this one.</summary>
    /// <response code="200">The requests, newest first.</response>
    /// <returns>The requests.</returns>
    [HttpGet("link-requests", Name = "StingStreamLinkRequests")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<LinkRequestSummary>> LinkRequests()
        => Ok(_identity.ListRequests());

    /// <summary>Let another server into one of this one's groups.</summary>
    /// <param name="issuer">The asking node's id.</param>
    /// <param name="request">Which group to add them to.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">They can join.</response>
    /// <response code="400">There is nowhere to put them, or a choice still to make.</response>
    /// <response code="404">No such request.</response>
    /// <returns>Nothing.</returns>
    [HttpPost("link-requests/{issuer}/approve", Name = "StingStreamApproveLink")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(IdentityError), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> ApproveLink(
        [FromRoute] string issuer,
        [FromBody] ApproveLinkRequest? request,
        CancellationToken cancellationToken)
    {
        var (ok, problem) = await _identity.ApproveRequestAsync(
            issuer,
            request?.GroupId,
            User?.Identity?.Name ?? string.Empty,
            DateTimeOffset.UtcNow,
            cancellationToken).ConfigureAwait(false);

        if (ok)
        {
            return NoContent();
        }

        return problem is null
            ? NotFound()
            : BadRequest(new IdentityError { Error = problem });
    }

    /// <summary>Say no to one.</summary>
    /// <param name="issuer">The asking node's id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Declined.</response>
    /// <response code="404">No such request, or it was already answered.</response>
    /// <returns>Nothing.</returns>
    [HttpPost("link-requests/{issuer}/decline", Name = "StingStreamDeclineLink")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> DeclineLink(
        [FromRoute] string issuer,
        CancellationToken cancellationToken)
    {
        var declined = await _identity.DeclineRequestAsync(
            issuer,
            User?.Identity?.Name ?? string.Empty,
            DateTimeOffset.UtcNow,
            cancellationToken).ConfigureAwait(false);
        return declined ? NoContent() : NotFound();
    }

    /// <summary>Which people on other servers hold an account here.</summary>
    /// <response code="200">The links, newest first.</response>
    /// <returns>The links.</returns>
    [HttpGet("links", Name = "StingStreamIdentityLinks")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<LinkedIdentitySummary>> Links() => Ok(_identity.List());

    /// <summary>Stop a remote identity signing in here.</summary>
    /// <param name="issuer">Their server's node id.</param>
    /// <param name="remoteUser">Their user id there.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">The link is gone.</response>
    /// <response code="404">There was no such link.</response>
    /// <returns>Nothing.</returns>
    /// <remarks>
    /// <b>The account stays.</b> Removing the link stops them signing in with their own server, so
    /// this is closer to disabling somebody than to tidying a table, and
    /// what they watched and where they got to is still theirs. Deleting the account itself is the
    /// Users screen's job, and is a separate decision.
    /// </remarks>
    [HttpDelete("links/{issuer}/{remoteUser}", Name = "StingStreamIdentityUnlink")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> Unlink(
        [FromRoute] string issuer,
        [FromRoute] string remoteUser,
        CancellationToken cancellationToken)
    {
        var removed = await _identity.UnlinkAsync(issuer, remoteUser, cancellationToken)
            .ConfigureAwait(false);
        return removed ? NoContent() : NotFound();
    }

    private static string Fallback(string? value, string fallback)
        => string.IsNullOrWhiteSpace(value) ? fallback : value;
}

/// <summary>One sentence saying why a sign-in was refused.</summary>
public sealed class IdentityError
{
    /// <summary>The sentence, written for the person who is reading it.</summary>
    public string Error { get; set; } = string.Empty;
}
