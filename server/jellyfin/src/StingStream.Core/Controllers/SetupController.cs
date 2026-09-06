using System;
using System.Linq;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Controller.Authentication;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using StingStream.Core.Data;
using StingStream.Core.FirstRun;

namespace StingStream.Core.Controllers;

/// <summary>
/// The first-run screen's two calls: is this node still unclaimed, and here is the account to make.
/// </summary>
/// <remarks>
/// <para>
/// A brand-new node has a bootstrap administrator with a generated password that exists in exactly
/// one place — <c>runtime.json</c> in the data directory — and asking a person to go and find it is
/// the worst first minute this product could have. Instead the node says "create your account", the
/// person types a name and a password, and the account they end up with is the one that was already
/// there, renamed. One screen, no wizard, nothing to copy out of a file.
/// </para>
/// <para>
/// <b>What stops somebody else claiming the node first.</b> Three things, in this order:
/// </para>
/// <list type="number">
/// <item>The gateway refuses <c>setup/admin</c> from any peer that is not on this machine, with the
/// same <c>404 no such route</c> it gives the arr webhook — the real control, because it is the only
/// place that sees the true socket peer.</item>
/// <item><see cref="SetupGate"/> refuses once the node has an account, so the window closes the
/// moment somebody uses it.</item>
/// <item><see cref="IsLoopback"/> here, as a second condition, in the shape
/// <c>WebhooksController</c> uses.</item>
/// </list>
/// <para>
/// Derived from <see cref="ControllerBase"/> rather than from <c>StingStreamControllerBase</c>,
/// exactly as <c>WebhooksController</c> is: the base class carries no route prefix that suits a
/// route pair sitting beside <c>setup/run</c>, and re-declaring the three attributes by hand is
/// what keeps these operations in the StingStream OpenAPI document.
/// </para>
/// </remarks>
[ApiController]
[AllowAnonymous]
[Route("stingstream/api/v1/setup")]
[Produces("application/json")]
[ApiExplorerSettings(GroupName = StingStreamApi.DocumentName)]
public sealed class SetupController : ControllerBase
{
    private readonly SettingsStore _settings;
    private readonly IUserManager _users;
    private readonly IServerConfigurationManager _serverConfig;
    private readonly ISessionManager _sessions;
    private readonly IAuthorizationContext _authContext;
    private readonly ILogger<SetupController> _logger;

    public SetupController(
        SettingsStore settings,
        IUserManager users,
        IServerConfigurationManager serverConfig,
        ISessionManager sessions,
        IAuthorizationContext authContext,
        ILogger<SetupController> logger)
    {
        _settings = settings;
        _users = users;
        _serverConfig = serverConfig;
        _sessions = sessions;
        _authContext = authContext;
        _logger = logger;
    }

    /// <summary>
    /// Whether this node still needs its first account, and whether you are on the machine that
    /// can create it.
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The two booleans.</response>
    /// <returns>The setup state.</returns>
    /// <remarks>
    /// Anonymous and ungated on purpose, and it answers from anywhere: a phone on the sofa has to
    /// be able to learn that a node is unclaimed so it can say "finish setup on the computer
    /// running StingStream" rather than a login form nobody can get through. It reveals one
    /// boolean, which <c>/healthz</c>'s public body already reveals as <c>first_run</c>.
    /// </remarks>
    [HttpGet("state", Name = "StingStreamSetupState")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<SetupState>> State(CancellationToken cancellationToken)
    {
        return new SetupState
        {
            Pending = await ResolvePendingAsync(cancellationToken).ConfigureAwait(false),
            Loopback = IsLoopback(),
        };
    }

    /// <summary>
    /// Create the account this node will be used with.
    /// </summary>
    /// <param name="request">The name and password somebody chose.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The account is yours, and here is a session for it.</response>
    /// <response code="400">The name or the password is not usable; the sentence says which.</response>
    /// <response code="404">The caller is not on this machine.</response>
    /// <response code="409">This node already has an account.</response>
    /// <returns>A signed-in session, exactly as signing in would have produced.</returns>
    /// <remarks>
    /// Renames the bootstrap administrator rather than creating a second account, so the libraries,
    /// the policies and the item that first-run wiring already attached to it stay attached. The
    /// answer is the same shape as a sign-in, so the app moves straight to the home screen instead
    /// of showing a login form to somebody who has just typed their password.
    /// </remarks>
    [HttpPost("admin", Name = "StingStreamSetupAdmin")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<AuthenticationResult>> CreateAdmin(
        [FromBody] SetupAdminRequest request,
        CancellationToken cancellationToken)
    {
        var pending = await ResolvePendingAsync(cancellationToken).ConfigureAwait(false);
        switch (SetupGate.Decide(pending, IsLoopback()))
        {
            case SetupAccess.NotLocal:
                _logger.LogWarning(
                    "Refused a first-run setup attempt from {Address}: setup can only be finished on "
                    + "the machine running this node",
                    HttpContext.Connection.RemoteIpAddress);
                return NotFound();

            case SetupAccess.NotPending:
                return Conflict(new SetupError { Error = "This server already has an account." });
        }

        var username = request?.Username?.Trim();
        var problem = SetupGate.Validate(username, request?.Password);
        if (problem is not null)
        {
            return BadRequest(new SetupError { Error = problem });
        }

        var account = _users.GetFirstUser();
        if (account is null)
        {
            // Only reachable if the bootstrap account vanished between the flag being set and this
            // call. Say so rather than 500ing: the answer is "restart the node", not "file a bug".
            _logger.LogError("First-run setup was asked to claim an account, and this node has none");
            return Conflict(new SetupError
            {
                Error = "This server has no account to claim; restart it and try again.",
            });
        }

        try
        {
            if (!string.Equals(account.Username, username, StringComparison.Ordinal))
            {
                await _users.RenameUser(account.Id, account.Username, username!).ConfigureAwait(false);
            }

            await _users.ChangePassword(account.Id, request!.Password!).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            // A name the server underneath will not take (a duplicate, say). The caller typed it,
            // so the caller gets told, not a 500.
            _logger.LogWarning(ex, "First-run setup could not claim the account");
            return BadRequest(new SetupError { Error = "That name cannot be used on this server." });
        }

        // The wizard must stay unreachable. The supervisor writes this into system.xml and
        // first-run wiring asserts it, and this is the third place it matters: a node whose
        // configuration was reset between the two would otherwise fall back into the startup
        // wizard, which leaves the API anonymously accessible.
        if (!_serverConfig.Configuration.IsStartupWizardCompleted)
        {
            _serverConfig.Configuration.IsStartupWizardCompleted = true;
            _serverConfig.SaveConfiguration();
            _logger.LogInformation("First-run setup marked the startup wizard complete");
        }

        // Before authenticating, not after: the window in which anyone on this machine can claim
        // the account closes the instant the password changes, and an authentication that then
        // fails for some unrelated reason must not reopen it.
        await FirstRunSetupState.SetAsync(_settings, false, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation("First-run setup complete; the account is now {Username}", username);

        var auth = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        var result = await _sessions.AuthenticateNewSession(new AuthenticationRequest
        {
            // The four identity fields are required and a first-run caller may legitimately have
            // sent none of them -- this is the one request the app makes before it has a session.
            App = Fallback(auth.Client, "StingStream"),
            AppVersion = Fallback(auth.Version, StingStreamApi.Version),
            DeviceId = Fallback(auth.DeviceId, "stingstream-setup"),
            DeviceName = Fallback(auth.Device, "First run"),
            Password = request.Password,
            RemoteEndPoint = HttpContext.GetNormalizedRemoteIP().ToString(),
            Username = username,
        }).ConfigureAwait(false);

        return result;
    }

    private static string Fallback(string? value, string fallback)
        => string.IsNullOrWhiteSpace(value) ? fallback : value;

    /// <summary>
    /// Whether setup is still pending, settling the stored flag when it is not.
    /// </summary>
    /// <remarks>
    /// The flag is set when first-run wiring creates the bootstrap administrator, and two things
    /// end it: this controller, and somebody signing in as that account on their own — which is
    /// what a person who read the generated password out of <c>runtime.json</c> does. There is no
    /// authentication hook to hang the second on, and the wiring pass that set the flag does not
    /// run again once it has succeeded, so it is settled here instead: a sign-in stamps
    /// <c>LastLoginDate</c>, and a second account can only exist because somebody made one. Either
    /// way the node is claimed, and the flag is cleared for good rather than being recomputed on
    /// every call.
    /// </remarks>
    private async Task<bool> ResolvePendingAsync(CancellationToken cancellationToken)
    {
        if (!FirstRunSetupState.Get(_settings).Pending)
        {
            return false;
        }

        var users = _users.GetUsers().ToList();
        if (users.Count == 1 && users[0].LastLoginDate is null)
        {
            return true;
        }

        _logger.LogInformation(
            "This node has been claimed already ({Count} account(s), signed in at least once); "
            + "first-run setup is closed",
            users.Count);
        await FirstRunSetupState.SetAsync(_settings, false, cancellationToken).ConfigureAwait(false);
        return false;
    }

    /// <summary>
    /// Whether the caller is on this machine.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>WebhooksController</c>'s remark says the same check is trivially true behind the gateway,
    /// because <c>/stingstream/api/*</c> is proxied over 127.0.0.1. Measured on a running node, it
    /// is not: the gateway <em>overwrites</em> <c>x-forwarded-for</c> with the real socket peer and
    /// this server trusts that header (<c>KnownProxies</c> is preseeded with <c>127.0.0.1</c>), so
    /// what arrives here is the true client address and a spoofed header from the LAN is discarded
    /// on the way through. This check refuses a LAN caller today, on its own.
    /// </para>
    /// <para>
    /// It is still the second condition and not the first, because it holds only as long as that
    /// configuration does — a node whose <c>KnownProxies</c> was cleared would see every request as
    /// loopback again, and nothing here would notice. The gateway's own path gate is the control;
    /// this is what answers when somebody reaches this server without going through it.
    /// </para>
    /// </remarks>
    private bool IsLoopback()
    {
        var address = HttpContext.Connection.RemoteIpAddress;
        if (address is null)
        {
            // No remote address at all means an in-process or unix-socket caller, which is at
            // least as trusted as loopback.
            return true;
        }

        if (IPAddress.IsLoopback(address))
        {
            return true;
        }

        // A v4 address arriving over a dual-stack socket is mapped into v6 space, and
        // IPAddress.IsLoopback does not see through the mapping.
        return address.IsIPv4MappedToIPv6 && IPAddress.IsLoopback(address.MapToIPv4());
    }
}

/// <summary>Whether this node still needs its first account.</summary>
public sealed class SetupState
{
    /// <summary>True while nobody has created an account on this node yet.</summary>
    public bool Pending { get; set; }

    /// <summary>
    /// True when this request came from the machine the node runs on, which is the only place the
    /// account can be created.
    /// </summary>
    public bool Loopback { get; set; }
}

/// <summary>The account somebody chose on the first-run screen.</summary>
public sealed class SetupAdminRequest
{
    /// <summary>The name for the account. Letters, digits, dots, underscores and dashes.</summary>
    public string? Username { get; set; }

    /// <summary>The password for the account. At least eight characters.</summary>
    public string? Password { get; set; }
}

/// <summary>One sentence saying why a setup request was refused.</summary>
public sealed class SetupError
{
    /// <summary>The sentence, written for the person who typed it.</summary>
    public string Error { get; set; } = string.Empty;
}
