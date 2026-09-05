using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Activity;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Logging;

namespace StingStream.Core.Requests;

/// <summary>The reasons a notification is sent, and the strings stored in <c>notifications.kind</c>.</summary>
public static class NotificationKinds
{
    /// <summary>To administrators: somebody's request is waiting for a decision.</summary>
    public const string RequestPending = "request_pending";

    /// <summary>To the requester: it was approved.</summary>
    public const string RequestApproved = "request_approved";

    /// <summary>To the requester: it was declined.</summary>
    public const string RequestDeclined = "request_declined";

    /// <summary>To the requester: it is in the library.</summary>
    public const string RequestAvailable = "request_available";

    /// <summary>To the requester and the administrators: nobody could fulfil it.</summary>
    public const string RequestFailed = "request_failed";
}

/// <summary>
/// Tells people what happened to a request, through three channels at once.
/// </summary>
/// <remarks>
/// <para>
/// A request is the one StingStream operation whose whole point is that it finishes *later*, often
/// hours later, on a machine the requester does not own. Nobody is watching a screen when it lands,
/// which is why this is not optional plumbing.
/// </para>
/// <list type="number">
///   <item><description>
///     A row in <c>notifications</c>, which the app polls. This is the durable one: it survives the
///     app being closed, which is the state it is in for most of a download.
///   </description></item>
///   <item><description>
///     A <c>DisplayMessage</c> general command to the person's live sessions, so somebody who *is*
///     looking at a screen sees it immediately rather than on the next poll.
///   </description></item>
///   <item><description>
///     A Jellyfin activity-log entry, which is where an administrator looks when asked "did that
///     ever happen". Jellyfin's own notification manager was removed from the server years ago and
///     lives in plugins now, so the activity log <em>is</em> Jellyfin's notification service in this
///     codebase, and the dashboard renders it.
///   </description></item>
/// </list>
/// <para>
/// Failures in any of the three are logged and swallowed. A notification that could not be
/// delivered must never fail the state change it was reporting: the request really did become
/// available, and losing that because a WebSocket was mid-reconnect would be the worse bug.
/// </para>
/// </remarks>
public sealed class RequestNotifier
{
    private readonly RequestStore _store;
    private readonly IUserManager _users;
    private readonly ISessionManager _sessions;
    private readonly IActivityManager _activity;
    private readonly ILogger<RequestNotifier> _logger;

    public RequestNotifier(
        RequestStore store,
        IUserManager users,
        ISessionManager sessions,
        IActivityManager activity,
        ILogger<RequestNotifier> logger)
    {
        _store = store;
        _users = users;
        _sessions = sessions;
        _activity = activity;
        _logger = logger;
    }

    /// <summary>Notify one member.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <param name="kind">One of <see cref="NotificationKinds"/>.</param>
    /// <param name="title">A short headline.</param>
    /// <param name="body">A sentence.</param>
    /// <param name="requestId">The request it is about.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task NotifyAsync(
        string userId,
        string kind,
        string title,
        string body,
        string? requestId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(userId))
        {
            return;
        }

        await _store.AddNotificationAsync(
                new NotificationRow
                {
                    UserId = userId,
                    Kind = kind,
                    Title = title,
                    Body = body,
                    RequestId = requestId,
                },
                cancellationToken)
            .ConfigureAwait(false);

        await PushAsync(new[] { userId }, title, body, cancellationToken).ConfigureAwait(false);
        await LogAsync(userId, kind, title, body).ConfigureAwait(false);
    }

    /// <summary>Notify every administrator on this node.</summary>
    /// <param name="kind">One of <see cref="NotificationKinds"/>.</param>
    /// <param name="title">A short headline.</param>
    /// <param name="body">A sentence.</param>
    /// <param name="requestId">The request it is about.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    /// <remarks>
    /// Every administrator, not "an" administrator: a request waiting for a decision is waiting for
    /// whoever gets to it first, and a household with two administrators where only one is told has
    /// a queue that stalls whenever that one is away.
    /// </remarks>
    public async Task NotifyAdministratorsAsync(
        string kind,
        string title,
        string body,
        string? requestId,
        CancellationToken cancellationToken)
    {
        var admins = Administrators();
        foreach (var admin in admins)
        {
            await _store.AddNotificationAsync(
                    new NotificationRow
                    {
                        UserId = admin.Id.ToString("N"),
                        Kind = kind,
                        Title = title,
                        Body = body,
                        RequestId = requestId,
                    },
                    cancellationToken)
                .ConfigureAwait(false);
        }

        await PushAsync(
                admins.Select(a => a.Id.ToString("N")).ToList(),
                title,
                body,
                cancellationToken)
            .ConfigureAwait(false);
        await LogAsync(string.Empty, kind, title, body).ConfigureAwait(false);
    }

    /// <summary>Every administrator on this node.</summary>
    /// <returns>The users.</returns>
    public IReadOnlyList<Jellyfin.Database.Implementations.Entities.User> Administrators()
    {
        try
        {
            return _users.GetUsers().Where(IsAdministrator).ToList();
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            _logger.LogWarning(ex, "Could not list administrators");
            return Array.Empty<Jellyfin.Database.Implementations.Entities.User>();
        }
    }

    /// <summary>A member's display name, or their id when Jellyfin does not know them.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <returns>The name.</returns>
    public string NameOf(string userId)
    {
        if (!Guid.TryParse(userId, out var id))
        {
            return userId;
        }

        try
        {
            return _users.GetUserById(id)?.Username ?? userId;
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            return userId;
        }
    }

    /// <summary>Whether a member is an administrator on this node.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <returns>True when they are.</returns>
    public bool IsAdministrator(string userId)
    {
        if (!Guid.TryParse(userId, out var id))
        {
            return false;
        }

        try
        {
            var user = _users.GetUserById(id);
            return user is not null && IsAdministrator(user);
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            return false;
        }
    }

    /// <summary>
    /// Whether a Jellyfin user holds the administrator permission.
    /// </summary>
    /// <param name="user">The user.</param>
    /// <returns>True when they do.</returns>
    /// <remarks>
    /// Jellyfin's own <c>UserEntityExtensions.HasPermission</c> would say this in one call, but it
    /// lives in the <c>Jellyfin.Data</c> project, which <c>StingStream.Core</c> does not reference —
    /// and adding a project reference to satisfy one predicate would widen this assembly's surface
    /// onto Jellyfin's data layer for no other reason. The permission collection is on the entity
    /// itself and reading it is the same lookup.
    /// </remarks>
    public static bool IsAdministrator(Jellyfin.Database.Implementations.Entities.User user)
    {
        ArgumentNullException.ThrowIfNull(user);
        foreach (var permission in user.Permissions)
        {
            if (permission.Kind == Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator)
            {
                return permission.Value;
            }
        }

        return false;
    }

    private async Task PushAsync(
        IReadOnlyList<string> userIds,
        string title,
        string body,
        CancellationToken cancellationToken)
    {
        var ids = new List<Guid>(userIds.Count);
        foreach (var id in userIds)
        {
            if (Guid.TryParse(id, out var parsed))
            {
                ids.Add(parsed);
            }
        }

        if (ids.Count == 0)
        {
            return;
        }

        var command = new GeneralCommand
        {
            Name = GeneralCommandType.DisplayMessage,
        };
        command.Arguments["Header"] = title;
        command.Arguments["Text"] = body;
        // Long enough to read a sentence and glance away. Jellyfin's own clients treat this as
        // milliseconds and ignore it when they have their own toast policy.
        command.Arguments["TimeoutMs"] = "8000";

        try
        {
            await _sessions
                .SendMessageToUserSessions(ids, SessionMessageType.GeneralCommand, command, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // A member with no session open is the normal case, not a fault; anything else here is
            // still not worth failing a state change over.
            _logger.LogDebug(ex, "Could not push a request notification to live sessions");
        }
    }

    private async Task LogAsync(string userId, string kind, string title, string body)
    {
        try
        {
            Guid.TryParse(userId, out var id);
            await _activity
                .CreateAsync(new ActivityLog(title, "StingStream.Request." + kind, id)
                {
                    Overview = body,
                    ShortOverview = body,
                })
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogDebug(ex, "Could not write a request to Jellyfin's activity log");
        }
    }
}
