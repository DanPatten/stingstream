using System;
using System.Threading.Tasks;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Users;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using StingStream.Core.Data;

namespace StingStream.Core.FirstRun;

/// <summary>Why disabling an account was refused.</summary>
public enum DisableRefusal
{
    /// <summary>Not refused.</summary>
    None,

    /// <summary>The account is the server's owner.</summary>
    Owner,

    /// <summary>The account is the caller's own.</summary>
    Self,
}

/// <summary>
/// Refuses to disable the server's owner, or the caller's own account, on Jellyfin's
/// <c>POST Users/{userId}/Policy</c>.
/// </summary>
/// <remarks>
/// <para>
/// Upstream refuses to disable <em>any</em> administrator, which is patch 9 in
/// <c>docs/PATCHES.md</c>: removed, because Dan wants administrators disableable like anybody else.
/// That upstream rule was, incidentally, the only thing stopping an owner or a caller from being
/// disabled, since both are always administrators on this screen. This filter puts back exactly
/// those two cases and no more.
/// </para>
/// <para>
/// An action filter rather than a second edit to <c>UserController</c>: who owns the server is a
/// StingStream question, answered from <see cref="FirstRunSetupState"/>, which <c>Jellyfin.Api</c>
/// cannot see.
/// </para>
/// </remarks>
public sealed class AccountDisableGuard : IAsyncActionFilter
{
    /// <summary>The claim Jellyfin's authentication handler puts the user id in.</summary>
    /// <remarks>The literal, for the reason given on <c>StingStreamControllerBase.UserIdClaim</c>.</remarks>
    private const string UserIdClaim = "Jellyfin-UserId";

    private readonly SettingsStore _settings;
    private readonly IUserManager _users;

    public AccountDisableGuard(SettingsStore settings, IUserManager users)
    {
        _settings = settings;
        _users = users;
    }

    /// <summary>Whether a policy save must be refused.</summary>
    /// <param name="disabling">Whether the new policy disables the account.</param>
    /// <param name="target">The account being changed.</param>
    /// <param name="caller">The caller's id, or empty for an API key.</param>
    /// <param name="ownerId">The owner's id as <see cref="ResolveOwner"/> gives it, or null.</param>
    /// <returns>Which rule refuses it, or <see cref="DisableRefusal.None"/>.</returns>
    /// <remarks>Owner first: it is the reason worth giving to an owner looking at their own account.</remarks>
    public static DisableRefusal Decide(bool disabling, Guid target, Guid caller, string? ownerId)
    {
        if (!disabling || target.Equals(Guid.Empty))
        {
            return DisableRefusal.None;
        }

        if (Guid.TryParse(ownerId, out var owner) && owner.Equals(target))
        {
            return DisableRefusal.Owner;
        }

        // An API key's claim is the all-zeros GUID, which the check above already rules out as a target.
        return caller.Equals(target) ? DisableRefusal.Self : DisableRefusal.None;
    }

    /// <summary>Which account owns this server, without writing anything down.</summary>
    /// <param name="settings">The StingStream settings store.</param>
    /// <param name="users">Jellyfin's user manager.</param>
    /// <returns>The owner's id in <c>N</c> format, or null on a server with no accounts.</returns>
    /// <remarks><see cref="SetupGate.ChooseOwner"/> is the rule.</remarks>
    public static string? ResolveOwner(SettingsStore settings, IUserManager users)
    {
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentNullException.ThrowIfNull(users);

        var recorded = FirstRunSetupState.Get(settings).OwnerUserId;
        var recordedExists = !string.IsNullOrWhiteSpace(recorded)
            && Guid.TryParse(recorded, out var recordedId)
            && users.GetUserById(recordedId) is not null;

        return SetupGate.ChooseOwner(recorded, recordedExists, users.GetFirstUser()?.Id.ToString("N"));
    }

    /// <inheritdoc />
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(next);

        var isPolicySave = context.ActionDescriptor is ControllerActionDescriptor action
            && action.ControllerName == "User"
            && action.ActionName == "UpdateUserPolicy";

        if (isPolicySave
            && context.ActionArguments.TryGetValue("userId", out var userIdArg)
            && userIdArg is Guid target
            && context.ActionArguments.TryGetValue("newPolicy", out var policyArg)
            && policyArg is UserPolicy { IsDisabled: true })
        {
            _ = Guid.TryParse(context.HttpContext.User?.FindFirst(UserIdClaim)?.Value, out var caller);
            var refusal = Decide(true, target, caller, ResolveOwner(_settings, _users));
            if (refusal != DisableRefusal.None)
            {
                context.Result = new ObjectResult(
                    refusal == DisableRefusal.Owner
                        ? "The owner cannot be disabled."
                        : "You cannot disable your own account.")
                {
                    StatusCode = StatusCodes.Status403Forbidden,
                };
                return;
            }
        }

        await next().ConfigureAwait(false);
    }
}
