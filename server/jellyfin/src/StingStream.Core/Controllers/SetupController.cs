using System;
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
using StingStream.Core.Configuration;
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
    private readonly INodeRuntimeProvider _runtime;
    private readonly IUserManager _users;
    private readonly IServerConfigurationManager _serverConfig;
    private readonly ISessionManager _sessions;
    private readonly IAuthorizationContext _authContext;
    private readonly ILogger<SetupController> _logger;

    public SetupController(
        SettingsStore settings,
        INodeRuntimeProvider runtime,
        IUserManager users,
        IServerConfigurationManager serverConfig,
        ISessionManager sessions,
        IAuthorizationContext authContext,
        ILogger<SetupController> logger)
    {
        _settings = settings;
        _runtime = runtime;
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
    public ActionResult<SetupState> State()
    {
        return new SetupState
        {
            Pending = ResolvePending(),
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
    [ProducesResponseType(typeof(SetupError), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(SetupError), StatusCodes.Status409Conflict)]
    public async Task<ActionResult<AuthenticationResult>> CreateAdmin(
        [FromBody] SetupAdminRequest request,
        CancellationToken cancellationToken)
    {
        switch (SetupGate.Decide(ResolvePending(), IsLoopback()))
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
            // First-run wiring has not created the bootstrap account yet -- a window of moments on
            // a brand-new node, and open indefinitely on one whose wiring failed. Not "claimed",
            // so not a 409 in spirit; but the caller has to be told to come back rather than shown
            // a login form for an account that does not exist.
            _logger.LogWarning("First-run setup was asked to claim an account before this node had one");
            return Conflict(new SetupError
            {
                Error = "This server is still starting up; try again in a moment.",
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
    /// Whether setup is still pending. A pure read: nothing here writes the flag.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Only a successful <c>setup/admin</c> ends it.</b> Signing in as the bootstrap account
    /// looks like it should count — somebody read the generated password out of
    /// <c>runtime.json</c> and used it, so the node is claimed — and an earlier version of this
    /// treated a stamped <c>LastLoginDate</c> that way. It is wrong twice over. Every acceptance
    /// harness and the UI-loop scripts sign in with those generated credentials on *every*
    /// connect, so the first connect closed setup, the supervisor scrubbed the password out of
    /// <c>runtime.json</c>, and the next harness step to read that field died on a field that was
    /// no longer there. And a person who signs in that way on a phone would be left with no setup
    /// screen and a random password they cannot change from memory. The generated credentials keep
    /// working for exactly as long as setup is pending, which is until somebody chooses their own.
    /// </para>
    /// <para>
    /// <b>"No flag written yet" is not "claimed", while the node is still on its first run.</b>
    /// The supervisor polls this endpoint and scrubs the generated password the moment it answers
    /// false, and there is a window between a fresh node's Kestrel accepting connections and its
    /// wiring pass reaching the administrator step. Answering false in that window scrubbed the
    /// password the wiring pass was about to use, and the node came up with an account nobody
    /// could sign into — which is what four acceptance harnesses did at once, before this. So an
    /// absent flag defers to <c>runtime.json</c>'s own <c>first_run</c>. A node that predates the
    /// flag has <c>first_run</c> clear and reads as claimed, which is the answer that keeps its
    /// account out of a stranger's hands.
    /// </para>
    /// </remarks>
    private bool ResolvePending()
    {
        var stored = _settings.GetDocument<FirstRunSetupState>(FirstRunSetupState.StorageKey);
        if (stored is not null)
        {
            return stored.Pending;
        }

        // Nothing recorded. Pending only while a first run is still in flight: a node wired by a
        // build that predates the flag has first_run clear, and somebody owns the accounts on it.
        return _runtime.Current?.FirstRun == true;
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
