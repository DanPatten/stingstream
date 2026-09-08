using System;
using System.ComponentModel.DataAnnotations;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Controller.Authentication;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using StingStream.Core.Mesh;

namespace StingStream.Core.Controllers;

/// <summary>
/// StingStream accounts, as this server sees them.
/// </summary>
/// <remarks>
/// <para>
/// A person signs in to the account service, is handed a signed token, and presents it here. This
/// controller checks the token and hands back an ordinary Jellyfin session — so from that point on
/// every screen, every permission and every resume point is Jellyfin's, unchanged, and nothing
/// downstream knows or cares that the sign-in came from an account rather than a password.
/// </para>
/// <para>
/// <b>The check is local.</b> It goes to the mesh, which verifies the signature against a public key
/// cached when this server was claimed — no call to the account service, ever. That is what lets
/// somebody sign in while the service is down, and it is why the crypto lives in the mesh: the key
/// and the Ed25519 code are both already there.
/// </para>
/// </remarks>
[ApiController]
[Route("stingstream/api/v1/accounts")]
public sealed class AccountsController : StingStreamControllerBase
{
    private readonly IMeshClient _mesh;
    private readonly IUserManager _users;
    private readonly ISessionManager _sessions;
    private readonly IAuthorizationContext _authContext;
    private readonly ILogger<AccountsController> _logger;

    /// <summary>Initializes a new instance of the <see cref="AccountsController"/> class.</summary>
    /// <param name="mesh">The mesh, which holds the node key and the cached signing key.</param>
    /// <param name="users">Jellyfin's user manager.</param>
    /// <param name="sessions">Jellyfin's session manager.</param>
    /// <param name="authContext">Reads the client identity off the request.</param>
    /// <param name="logger">Logger.</param>
    public AccountsController(
        IMeshClient mesh,
        IUserManager users,
        ISessionManager sessions,
        IAuthorizationContext authContext,
        ILogger<AccountsController> logger)
    {
        _mesh = mesh;
        _users = users;
        _sessions = sessions;
        _authContext = authContext;
        _logger = logger;
    }

    /// <summary>Which account service this server uses, and whose account it belongs to.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The account status.</response>
    /// <returns>The account status.</returns>
    [HttpGet]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<MeshAccountStatus>> Status(CancellationToken cancellationToken)
        => await _mesh.AccountStatusAsync(cancellationToken).ConfigureAwait(false);

    /// <summary>Create a StingStream account, or attach this server to one that exists.</summary>
    /// <param name="body">The username and password.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The account this server now belongs to.</response>
    /// <returns>The account status.</returns>
    /// <remarks>
    /// Administrator only, and deliberately: claiming a server is not something a member of somebody
    /// else's household gets to do to the machine they are watching on.
    /// </remarks>
    [HttpPost("register")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<MeshAccountStatus>> Register(
        [FromBody, Required] RegisterAccountRequest body,
        CancellationToken cancellationToken)
        => await _mesh
            .AccountRegisterAsync(body.Username, body.Password, body.Claim, cancellationToken)
            .ConfigureAwait(false);

    /// <summary>Set a new password on the account this server belongs to.</summary>
    /// <param name="body">The new password.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The account status.</response>
    /// <returns>The account status.</returns>
    /// <remarks>
    /// The only recovery there is. With no email there is no reset link, so proving you own the
    /// account means proving you control a machine it already owns — which is what being an
    /// administrator here demonstrates.
    /// </remarks>
    [HttpPost("reset")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<MeshAccountStatus>> Reset(
        [FromBody, Required] ResetAccountRequest body,
        CancellationToken cancellationToken)
        => await _mesh.AccountResetAsync(body.Password, cancellationToken).ConfigureAwait(false);

    /// <summary>Exchange an account token for a session on this server.</summary>
    /// <param name="body">The token from the account service.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">A Jellyfin session.</response>
    /// <response code="401">The token is not valid, or not for this server.</response>
    /// <returns>The authentication result.</returns>
    /// <remarks>
    /// <para>
    /// Anonymous, because it is a sign-in: the token <i>is</i> the credential, and it is checked
    /// before anything else happens. The mesh refuses a token that names a different server, so one
    /// person's token cannot be presented to everybody's node.
    /// </para>
    /// <para>
    /// The local user is created on first sight and then reused, which is what makes watch history
    /// and resume points work: they are an ordinary Jellyfin user's, in the place Jellyfin already
    /// keeps them.
    /// </para>
    /// </remarks>
    [HttpPost("session")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<AuthenticationResult>> Session(
        [FromBody, Required] AccountSessionRequest body,
        CancellationToken cancellationToken)
    {
        MeshAccountSession verified;
        try
        {
            verified = await _mesh.AccountVerifyAsync(body.Token, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Deliberately not the mesh's message. A caller who fails here has presented a token
            // that does not verify; telling them whether it was the signature, the expiry or the
            // server it names is a description of our checks, and of no use to somebody holding a
            // token they are entitled to.
            _logger.LogWarning(ex, "An account token was refused");
            return Unauthorized(new { error = "that sign-in is not valid for this server" });
        }

        var user = _users.GetUserByName(verified.Username);
        if (user is null)
        {
            _logger.LogInformation(
                "Creating a local user for StingStream account {Username}",
                verified.Username);
            user = await _users.CreateUserAsync(verified.Username).ConfigureAwait(false);
        }

        var auth = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);

        // `AuthenticateDirect`, not `AuthenticateNewSession`: there is no local password to check,
        // and inventing one would be a second credential to keep in step. The same path Quick
        // Connect uses, for the same reason — the proof happened before we got here.
        return await _sessions.AuthenticateDirect(new AuthenticationRequest
        {
            App = Fallback(auth.Client, "StingStream"),
            AppVersion = Fallback(auth.Version, StingStreamApi.Version),
            DeviceId = Fallback(auth.DeviceId, "stingstream-account"),
            DeviceName = Fallback(auth.Device, "StingStream"),
            RemoteEndPoint = HttpContext.GetNormalizedRemoteIP().ToString(),
            UserId = user.Id,
            Username = user.Username,
        }).ConfigureAwait(false);
    }

    private static string Fallback(string? value, string fallback)
        => string.IsNullOrWhiteSpace(value) ? fallback : value;
}

/// <summary>Body of <c>POST /accounts/register</c>.</summary>
public sealed class RegisterAccountRequest
{
    /// <summary>The username to create, or the one to attach to.</summary>
    public string Username { get; set; } = string.Empty;

    /// <summary>The password.</summary>
    public string Password { get; set; } = string.Empty;

    /// <summary>True to attach this server to an account that already exists.</summary>
    public bool Claim { get; set; }
}

/// <summary>Body of <c>POST /accounts/reset</c>.</summary>
public sealed class ResetAccountRequest
{
    /// <summary>The new password.</summary>
    public string Password { get; set; } = string.Empty;
}

/// <summary>Body of <c>POST /accounts/session</c>.</summary>
public sealed class AccountSessionRequest
{
    /// <summary>A token from the account service.</summary>
    public string Token { get; set; } = string.Empty;
}
