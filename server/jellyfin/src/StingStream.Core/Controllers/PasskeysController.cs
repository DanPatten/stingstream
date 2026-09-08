using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Controller.Authentication;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using StingStream.Core.Passkeys;

namespace StingStream.Core.Controllers;

/// <summary>
/// Passkeys: registering one on an account, and signing in with one.
/// </summary>
/// <remarks>
/// <para>
/// The two halves have opposite authorization and it is worth saying why in one place.
/// <b>Registering requires a session</b>, because it adds a second way into an account and so takes
/// somebody who has already proved they hold the first. <b>Signing in is anonymous</b>, because the
/// passkey <em>is</em> the credential — requiring a session to use one would be requiring a sign-in
/// to sign in.
/// </para>
/// <para>
/// A ceremony is two requests, and the challenge lives on the server in between
/// (<see cref="PasskeyCeremonies"/>). Everything binary travels as base64url in JSON; the client
/// half of that translation is <c>lib/stingstream/webauthn.ts</c>, which is reused unchanged from
/// the deleted account service because the ceremony JSON is the spec's, not ours.
/// </para>
/// <para>
/// Derived from <see cref="ControllerBase"/> and re-declaring its four attributes, exactly as
/// <c>SetupController</c>, <c>WebhooksController</c> and <c>InvitesController</c> do — without
/// <c>[ApiExplorerSettings]</c> these operations vanish from <c>openapi.json</c> and nothing
/// notices.
/// </para>
/// </remarks>
[ApiController]
[Authorize]
[Route("stingstream/api/v1/passkeys")]
[Produces("application/json")]
[ApiExplorerSettings(GroupName = StingStreamApi.DocumentName)]
public sealed class PasskeysController : ControllerBase
{
    private const string UserIdClaim = "Jellyfin-UserId";

    private readonly PasskeyService _passkeys;
    private readonly IUserManager _users;
    private readonly ISessionManager _sessions;
    private readonly IAuthorizationContext _authContext;
    private readonly ILogger<PasskeysController> _logger;

    public PasskeysController(
        PasskeyService passkeys,
        IUserManager users,
        ISessionManager sessions,
        IAuthorizationContext authContext,
        ILogger<PasskeysController> logger)
    {
        _passkeys = passkeys;
        _users = users;
        _sessions = sessions;
        _authContext = authContext;
        _logger = logger;
    }

    /// <summary>Whether this server can offer passkeys, and what they would be bound to.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The answer, and a sentence when it is no.</response>
    /// <returns>The support state.</returns>
    /// <remarks>
    /// Anonymous, because the sign-in screen has to know whether to draw the button before anybody
    /// has signed in. It reveals the server's own domain, which is the address the caller used to
    /// reach it.
    /// </remarks>
    [HttpGet(Name = "StingStreamPasskeySupport")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<PasskeySupportState>> Support(CancellationToken cancellationToken)
    {
        var (support, party) = await _passkeys.SupportAsync(cancellationToken).ConfigureAwait(false);
        return new PasskeySupportState
        {
            Supported = support == PasskeySupport.Supported,
            Reason = PasskeyOrigin.Explain(support),
            RelyingParty = party?.Domain,
        };
    }

    /// <summary>The passkeys on the calling account.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The list, newest first.</response>
    /// <returns>The passkeys.</returns>
    [HttpGet("credentials", Name = "StingStreamPasskeys")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<PasskeySummary>>> Credentials(
        CancellationToken cancellationToken)
    {
        var (_, party) = await _passkeys.SupportAsync(cancellationToken).ConfigureAwait(false);
        return Ok(_passkeys.ForUser(CurrentUserId(), party));
    }

    /// <summary>Rename one of the calling account's passkeys.</summary>
    /// <param name="id">The credential id.</param>
    /// <param name="request">The new name.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Renamed.</response>
    /// <response code="404">No such passkey on this account.</response>
    /// <returns>Nothing.</returns>
    [HttpPost("credentials/{id}/rename", Name = "StingStreamRenamePasskey")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> Rename(
        string id,
        [FromBody] PasskeyLabelRequest request,
        CancellationToken cancellationToken)
        => await _passkeys.RenameAsync(id, CurrentUserId(), request?.Label ?? string.Empty, cancellationToken)
                .ConfigureAwait(false)
            ? NoContent()
            : NotFound();

    /// <summary>Remove one of the calling account's passkeys.</summary>
    /// <param name="id">The credential id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Removed.</response>
    /// <response code="404">No such passkey on this account.</response>
    /// <returns>Nothing.</returns>
    /// <remarks>
    /// Scoped to the caller in the delete itself, not by a check before it, so a credential id
    /// belonging to somebody else cannot be removed by guessing one.
    /// </remarks>
    [HttpDelete("credentials/{id}", Name = "StingStreamDeletePasskey")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> Delete(string id, CancellationToken cancellationToken)
        => await _passkeys.DeleteAsync(id, CurrentUserId(), cancellationToken).ConfigureAwait(false)
            ? NoContent()
            : NotFound();

    /// <summary>Start adding a passkey to the calling account.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The challenge to answer.</response>
    /// <response code="409">This server cannot offer passkeys; the sentence says why.</response>
    /// <returns>The challenge.</returns>
    [HttpPost("register/begin", Name = "StingStreamBeginPasskeyRegistration")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(PasskeyError), StatusCodes.Status409Conflict)]
    public async Task<ActionResult<PasskeyChallenge>> BeginRegistration(CancellationToken cancellationToken)
    {
        if (await CurrentUserAsync().ConfigureAwait(false) is not { } user)
        {
            return Unauthorized();
        }

        var (challenge, problem) = await _passkeys
            .BeginRegistrationAsync(user, cancellationToken)
            .ConfigureAwait(false);

        return problem is not null
            ? Conflict(new PasskeyError { Error = problem })
            : Ok(challenge);
    }

    /// <summary>Finish adding a passkey.</summary>
    /// <param name="request">The ceremony id and what the authenticator produced.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Registered.</response>
    /// <response code="400">It could not be verified; the sentence says what to do.</response>
    /// <returns>Nothing.</returns>
    [HttpPost("register/finish", Name = "StingStreamFinishPasskeyRegistration")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(PasskeyError), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult> FinishRegistration(
        [FromBody] PasskeyRegistrationRequest request,
        CancellationToken cancellationToken)
    {
        if (await CurrentUserAsync().ConfigureAwait(false) is not { } user)
        {
            return Unauthorized();
        }

        var problem = await _passkeys.FinishRegistrationAsync(
            user,
            request?.Ceremony,
            request?.Credential ?? default,
            request?.Label,
            cancellationToken).ConfigureAwait(false);

        return problem is not null
            ? BadRequest(new PasskeyError { Error = problem })
            : NoContent();
    }

    /// <summary>Start signing in with a passkey.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The challenge to answer.</response>
    /// <response code="409">This server cannot offer passkeys; the sentence says why.</response>
    /// <returns>The challenge.</returns>
    /// <remarks>
    /// Anonymous, and it takes no username: the credentials are discoverable, so the authenticator
    /// offers what it holds for this domain. Which also means this endpoint cannot be used to ask
    /// whether an account exists here.
    /// </remarks>
    [HttpPost("login/begin", Name = "StingStreamBeginPasskeyLogin")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(PasskeyError), StatusCodes.Status409Conflict)]
    public async Task<ActionResult<PasskeyChallenge>> BeginLogin(CancellationToken cancellationToken)
    {
        var (challenge, problem) = await _passkeys.BeginLoginAsync(cancellationToken).ConfigureAwait(false);
        return problem is not null
            ? Conflict(new PasskeyError { Error = problem })
            : Ok(challenge);
    }

    /// <summary>Finish signing in with a passkey.</summary>
    /// <param name="request">The ceremony id and what the authenticator produced.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">A session, exactly as a password sign-in produces.</response>
    /// <response code="401">It could not be verified.</response>
    /// <returns>The session.</returns>
    /// <remarks>
    /// Ends at <c>AuthenticateDirect</c> rather than <c>AuthenticateNewSession</c>: there is no
    /// password to check, because the proof already happened in the ceremony. That is the whole
    /// difference between the two methods, and using the wrong one here would mean asking for a
    /// credential this flow exists to avoid.
    /// </remarks>
    [HttpPost("login/finish", Name = "StingStreamFinishPasskeyLogin")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(PasskeyError), StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<AuthenticationResult>> FinishLogin(
        [FromBody] PasskeyLoginRequest request,
        CancellationToken cancellationToken)
    {
        var (user, problem) = await _passkeys.FinishLoginAsync(
            request?.Ceremony,
            request?.Credential ?? default,
            cancellationToken).ConfigureAwait(false);

        if (user is null)
        {
            return Unauthorized(new PasskeyError { Error = problem ?? "That passkey could not be used." });
        }

        var auth = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        var result = await _sessions.AuthenticateDirect(new AuthenticationRequest
        {
            UserId = user.Id,
            Username = user.Username,
            App = Fallback(auth.Client, "StingStream"),
            AppVersion = Fallback(auth.Version, StingStreamApi.Version),
            DeviceId = Fallback(auth.DeviceId, "stingstream-passkey"),
            DeviceName = Fallback(auth.Device, "Passkey"),
            RemoteEndPoint = HttpContext.GetNormalizedRemoteIP().ToString(),
        }).ConfigureAwait(false);

        _logger.LogInformation("{User} signed in with a passkey", user.Username);
        return result;
    }

    private static string Fallback(string? value, string fallback)
        => string.IsNullOrWhiteSpace(value) ? fallback : value;

    private string CurrentUserId() => User?.FindFirst(UserIdClaim)?.Value ?? string.Empty;

    /// <summary>
    /// The signed-in account, or null for an API-key caller.
    /// </summary>
    /// <remarks>
    /// Null for an API key on purpose. Jellyfin stamps <c>role = Administrator</c> on every API-key
    /// request, so an API key is a full-power credential on this API — but it names no *person*,
    /// and a passkey belongs to one. Registering one against the all-zeros user id would produce a
    /// credential nobody could ever use.
    /// </remarks>
    private async Task<User?> CurrentUserAsync()
    {
        var auth = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        if (auth.User is not null)
        {
            return auth.User;
        }

        return Guid.TryParse(CurrentUserId(), out var id) && !id.Equals(Guid.Empty)
            ? _users.GetUserById(id)
            : null;
    }
}

/// <summary>Whether this server can offer passkeys.</summary>
public sealed class PasskeySupportState
{
    /// <summary>True when a ceremony would work.</summary>
    public bool Supported { get; set; }

    /// <summary>One sentence saying why not, or null.</summary>
    public string? Reason { get; set; }

    /// <summary>The domain passkeys bind to, or null.</summary>
    public string? RelyingParty { get; set; }
}

/// <summary>A finished registration ceremony.</summary>
/// <remarks>
/// <b>The credential is <see cref="JsonElement"/> rather than the library's own model, and that is
/// load-bearing.</b> Fido2NetLib's response types are annotated for a plain serializer:
/// <c>[JsonConverter(Base64UrlConverter)]</c> on their byte arrays, and an <c>EnumMember</c>
/// spelling of <c>"public-key"</c> on the credential type. Jellyfin's serializer is configured for
/// a decade of Jellyfin clients and registers its own enum converters in
/// <c>options.Converters</c> — which, by System.Text.Json's precedence rules, <em>beat</em> a
/// converter declared on the type. Binding the library's models through Jellyfin's serializer
/// therefore fails on the very first field, with a 400 naming a type nobody in the browser has
/// heard of. Taking the credential as raw JSON and letting the library parse it with its own rules
/// is what keeps the two configurations apart; <c>PasskeyService.Parse</c> is the seam.
/// </remarks>
public sealed class PasskeyRegistrationRequest
{
    /// <summary>The ceremony id from `register/begin`.</summary>
    public string? Ceremony { get; set; }

    /// <summary>What the authenticator produced, verbatim.</summary>
    public JsonElement Credential { get; set; }

    /// <summary>What to call it. Optional.</summary>
    public string? Label { get; set; }
}

/// <summary>A finished sign-in ceremony.</summary>
/// <remarks>See <see cref="PasskeyRegistrationRequest"/> for why the credential is raw JSON.</remarks>
public sealed class PasskeyLoginRequest
{
    /// <summary>The ceremony id from `login/begin`.</summary>
    public string? Ceremony { get; set; }

    /// <summary>What the authenticator produced, verbatim.</summary>
    public JsonElement Credential { get; set; }
}

/// <summary>A new name for a passkey.</summary>
public sealed class PasskeyLabelRequest
{
    /// <summary>The name.</summary>
    public string? Label { get; set; }
}

/// <summary>One sentence saying why a passkey request was refused.</summary>
public sealed class PasskeyError
{
    /// <summary>The sentence, written for the person reading it.</summary>
    public string Error { get; set; } = string.Empty;
}
