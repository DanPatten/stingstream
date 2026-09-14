using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using StingStream.Core.Mesh;
using StingStream.Core.Sharing;

namespace StingStream.Core.Controllers;

/// <summary>
/// Connecting this server to another one: invite links, and the requests members bring back.
/// </summary>
/// <remarks>
/// <para>
/// Dan: <em>"one user does EVERYTHING once and they are done. The other user does everything once and
/// they are done."</em> An administrator makes an invite, choosing what this server shares as part of
/// making it. An administrator on the other server uses it, choosing what theirs shares as part of
/// using it. That is the whole connection.
/// </para>
/// <para>
/// A member cannot decide what this server shares, so a member who opens or brings an invite link
/// files a <see cref="ConnectionRequest"/> instead, and an administrator approves it in one step.
/// See <c>docs/INVITES.md</c> §11.
/// </para>
/// </remarks>
[Authorize]
public sealed class ConnectionsController : StingStreamControllerBase
{
    private readonly ConnectionService _connections;
    private readonly ConnectionRequestStore _requests;
    private readonly IUserManager _users;
    private readonly ILogger<ConnectionsController> _logger;

    public ConnectionsController(
        ConnectionService connections,
        ConnectionRequestStore requests,
        IUserManager users,
        ILogger<ConnectionsController> logger)
    {
        _connections = connections;
        _requests = requests;
        _users = users;
        _logger = logger;
    }

    /// <summary>Make an invite link that shares the chosen libraries.</summary>
    /// <param name="body">The libraries this server shares.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The invite.</response>
    /// <response code="400">It could not be made, and why.</response>
    /// <returns>The code, this node's id and this server's name, for the link.</returns>
    [HttpPost("invite")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ConnectionInvite>> Invite(
        [FromBody] ConnectionLibrariesBody? body,
        CancellationToken cancellationToken)
    {
        try
        {
            return Ok(await _connections
                .CreateInviteAsync(Libraries(body?.Libraries), cancellationToken)
                .ConfigureAwait(false));
        }
        catch (Exception ex) when (ex is MeshException or InvalidOperationException or System.Net.Http.HttpRequestException)
        {
            _logger.LogWarning(ex, "Could not make an invite link");
            return BadRequest(new { error = "The invite link could not be created. Try again." });
        }
    }

    /// <summary>Use another server's invite link, sharing the chosen libraries back.</summary>
    /// <param name="body">The code and the libraries this server shares.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">Connected.</response>
    /// <response code="400">It could not be used, and why.</response>
    /// <returns>The connection.</returns>
    [HttpPost("connect")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<MeshJoinResult>> Connect(
        [FromBody] ConnectBody? body,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(body?.Code))
        {
            return BadRequest(new { error = "This invite link is not valid. Ask for a new one." });
        }

        return await ConnectAsync(body.Code, Libraries(body.Libraries), cancellationToken)
            .ConfigureAwait(false);
    }

    /// <summary>Invite links waiting for an administrator.</summary>
    /// <response code="200">Every request for an administrator; a member's own for a member.</response>
    /// <returns>The requests, newest first. Never the codes.</returns>
    [HttpGet("requests")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<ConnectionRequestSummary>> Requests()
    {
        var admin = IsAdministrator();
        return Ok(_requests.All(DateTimeOffset.UtcNow)
            .Where(row => admin || IsSelf(row.RequestedBy))
            .Select(row => new ConnectionRequestSummary
            {
                Id = row.Id,
                Node = row.Node,
                ServerName = row.ServerName,
                RequestedByName = Guid.TryParse(row.RequestedBy, out var id)
                    ? _users.GetUserById(id)?.Username ?? string.Empty
                    : string.Empty,
                CreatedAt = row.CreatedAt.ToString("O", CultureInfo.InvariantCulture),
                Mine = IsSelf(row.RequestedBy),
            })
            .ToArray());
    }

    /// <summary>Bring an invite link here for an administrator to approve.</summary>
    /// <param name="body">What the link carried.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Saved.</response>
    /// <response code="400">The link was incomplete.</response>
    /// <returns>Nothing.</returns>
    /// <remarks>
    /// Any member. Bringing a link decides nothing: the code only works once an administrator here
    /// approves it, and the other server already chose what it shares when it made the link.
    /// </remarks>
    [HttpPost("requests")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult> SaveRequest(
        [FromBody] ConnectionRequestBody? body,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(body?.Code))
        {
            return BadRequest(new { error = "This invite link is not valid. Ask for a new one." });
        }

        var now = DateTimeOffset.UtcNow;
        await _requests.PruneAsync(now, cancellationToken).ConfigureAwait(false);
        await _requests.SaveAsync(
            new ConnectionRequest
            {
                Id = Guid.NewGuid().ToString("N"),
                Code = body.Code.Trim(),
                Node = body.Node?.Trim() ?? string.Empty,
                ServerName = body.ServerName?.Trim() ?? string.Empty,
                RequestedBy = CurrentUserId(),
                CreatedAt = now,
            },
            cancellationToken).ConfigureAwait(false);
        return NoContent();
    }

    /// <summary>Approve a request, sharing the chosen libraries.</summary>
    /// <param name="id">The request.</param>
    /// <param name="body">The libraries this server shares.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">Connected.</response>
    /// <response code="400">The invite could not be used, and why.</response>
    /// <response code="404">No such request, or it has expired.</response>
    /// <returns>The connection.</returns>
    [HttpPost("requests/{id}/approve")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<MeshJoinResult>> Approve(
        [FromRoute] string id,
        [FromBody] ConnectionLibrariesBody? body,
        CancellationToken cancellationToken)
    {
        var row = _requests.Find(id, DateTimeOffset.UtcNow);
        if (row is null)
        {
            return NotFound();
        }

        var result = await ConnectAsync(row.Code, Libraries(body?.Libraries), cancellationToken)
            .ConfigureAwait(false);

        // Removed whether it worked or not when the invite itself is spent or expired: it can never
        // work, and leaving it would offer an Approve that fails the same way every time.
        if (result.Result is not BadRequestObjectResult || InviteIsDead(result))
        {
            await _requests.DeleteAsync(row.Id, cancellationToken).ConfigureAwait(false);
        }

        return result;
    }

    /// <summary>Decline a request, or withdraw your own.</summary>
    /// <param name="id">The request.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Removed.</response>
    /// <response code="404">No such request, or not yours to remove.</response>
    /// <returns>Nothing.</returns>
    [HttpDelete("requests/{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> Decline([FromRoute] string id, CancellationToken cancellationToken)
    {
        var row = _requests.Find(id, DateTimeOffset.UtcNow);
        if (row is null || !(IsAdministrator() || IsSelf(row.RequestedBy)))
        {
            return NotFound();
        }

        await _requests.DeleteAsync(row.Id, cancellationToken).ConfigureAwait(false);
        return NoContent();
    }

    private async Task<ActionResult<MeshJoinResult>> ConnectAsync(
        string code,
        IReadOnlyList<Guid> libraries,
        CancellationToken cancellationToken)
    {
        try
        {
            return Ok(await _connections.ConnectAsync(code, libraries, cancellationToken)
                .ConfigureAwait(false));
        }
        catch (Exception ex) when (ex is MeshException or InvalidOperationException or System.Net.Http.HttpRequestException or TaskCanceledException)
        {
            _logger.LogWarning(ex, "Could not use an invite link");
            return BadRequest(new { error = ConnectionService.Explain(ex) });
        }
    }

    private static bool InviteIsDead(ActionResult<MeshJoinResult> result)
        => result.Result is BadRequestObjectResult { Value: { } value }
           && value.ToString() is { } text
           && (text.Contains("expired", StringComparison.Ordinal)
               || text.Contains("already been used", StringComparison.Ordinal)
               || text.Contains("not valid", StringComparison.Ordinal));

    private IReadOnlyList<Guid> Libraries(IReadOnlyList<Guid>? chosen)
        => chosen is null
            ? _connections.AllLibraries()
            : chosen.Where(id => !id.Equals(Guid.Empty)).Distinct().ToArray();
}

/// <summary>Body naming which libraries this server shares.</summary>
public sealed class ConnectionLibrariesBody
{
    /// <summary>The libraries. Absent shares every library; empty shares none.</summary>
    public IReadOnlyList<Guid>? Libraries { get; set; }
}

/// <summary>Body of <c>POST /connections/connect</c>.</summary>
public sealed class ConnectBody
{
    /// <summary>The code from the invite link.</summary>
    public string? Code { get; set; }

    /// <summary>The libraries this server shares. Absent shares every library.</summary>
    public IReadOnlyList<Guid>? Libraries { get; set; }
}

/// <summary>Body of <c>POST /connections/requests</c>: what an invite link carried.</summary>
public sealed class ConnectionRequestBody
{
    /// <summary>The code.</summary>
    public string? Code { get; set; }

    /// <summary>Node id of the server that made it.</summary>
    public string? Node { get; set; }

    /// <summary>What that server calls itself.</summary>
    public string? ServerName { get; set; }
}

/// <summary>One request, as the Servers page lists it.</summary>
public sealed class ConnectionRequestSummary
{
    /// <summary>The id to approve or decline by.</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>Node id of the server that made the invite.</summary>
    public string Node { get; set; } = string.Empty;

    /// <summary>What that server calls itself.</summary>
    public string ServerName { get; set; } = string.Empty;

    /// <summary>Who brought it.</summary>
    public string RequestedByName { get; set; } = string.Empty;

    /// <summary>When, ISO 8601.</summary>
    public string CreatedAt { get; set; } = string.Empty;

    /// <summary>Whether the caller brought it.</summary>
    public bool Mine { get; set; }
}
