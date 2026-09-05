using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using StingStream.Core.Federated;
using StingStream.Core.Mesh;

namespace StingStream.Core.Controllers;

/// <summary>
/// Groups, peers and the shared index: the StingStream API over this node's mesh.
/// </summary>
/// <remarks>
/// The mesh's own API is on loopback and unauthenticated, because anything that can reach it is
/// already on the machine. This controller is how the *app* reaches it: through the gateway, with
/// Jellyfin's own authentication, so the Group screen does not need a second credential.
///
/// Everything that changes group membership requires elevation. Creating a group, minting an
/// invite and joining one are all administrator actions on a node — a group is the node's identity
/// in the mesh, not a per-user setting.
/// </remarks>
[Authorize]
public sealed class MeshController : StingStreamControllerBase
{
    private readonly IMeshClient _mesh;
    private readonly FederatedLibraryService _federated;

    public MeshController(IMeshClient mesh, FederatedLibraryService federated)
    {
        _mesh = mesh;
        _federated = federated;
    }

    /// <summary>This node's mesh identity, addresses and group count.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The status.</response>
    /// <response code="503">This node has no mesh, or it is not answering.</response>
    /// <returns>The mesh status.</returns>
    [HttpGet("status")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<MeshStatus>> Status(CancellationToken cancellationToken)
    {
        var status = await _mesh.StatusAsync(cancellationToken).ConfigureAwait(false);
        return status is null
            ? StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "the mesh is not answering" })
            : status;
    }

    /// <summary>Every group this node belongs to.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The groups.</response>
    /// <returns>The groups.</returns>
    [HttpGet("groups")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<MeshGroup>>> Groups(CancellationToken cancellationToken)
        => Ok(await _mesh.GroupsAsync(cancellationToken).ConfigureAwait(false));

    /// <summary>Create a group.</summary>
    /// <param name="body">Name, and optionally a coordinator URL.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The new group.</response>
    /// <returns>The new group.</returns>
    [HttpPost("groups")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<MeshGroup>> CreateGroup(
        [FromBody] CreateGroupRequest body,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(body);
        return await _mesh.CreateGroupAsync(body.Name, body.Coordinator, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Join a group from an invite code.</summary>
    /// <param name="body">The invite code.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">What the join reached.</response>
    /// <returns>The join result.</returns>
    [HttpPost("groups/join")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<MeshJoinResult>> Join(
        [FromBody] JoinGroupRequest body,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(body);
        return await _mesh.JoinGroupAsync(body.Code, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Mint an invite code.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The invite code.</response>
    /// <returns>The invite code.</returns>
    [HttpPost("groups/{group}/invite")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<MeshInvite>> Invite(string group, CancellationToken cancellationToken)
        => new MeshInvite { Code = await _mesh.InviteAsync(group, cancellationToken).ConfigureAwait(false) };

    /// <summary>Leave a group.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Left.</response>
    /// <response code="404">This node is not a member of that group.</response>
    /// <returns>No content.</returns>
    [HttpDelete("groups/{group}")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> Leave(string group, CancellationToken cancellationToken)
        => await _mesh.LeaveGroupAsync(group, cancellationToken).ConfigureAwait(false)
            ? NoContent()
            : NotFound();

    /// <summary>The merged group index: every member's titles.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The index.</response>
    /// <returns>The index.</returns>
    [HttpGet("groups/{group}/index")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<MeshIndex>> Index(string group, CancellationToken cancellationToken)
        => await _mesh.IndexAsync(group, cancellationToken).ConfigureAwait(false);

    /// <summary>Group membership, liveness, observed path and advertised capacity.</summary>
    /// <param name="group">The group id, or omit for every group.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The peers.</response>
    /// <returns>The peers.</returns>
    [HttpGet("peers")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<MeshPeer>>> Peers(
        [FromQuery] string? group,
        CancellationToken cancellationToken)
        => Ok(await _mesh.PeersAsync(group, cancellationToken).ConfigureAwait(false));

    /// <summary>
    /// Run one federated-library materialization pass now.
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">What the pass did.</response>
    /// <returns>The report.</returns>
    /// <remarks>
    /// The service already runs one every few seconds; this exists so a harness or an impatient
    /// administrator does not have to wait for the timer, and so a failure has somewhere to report
    /// itself synchronously.
    /// </remarks>
    [HttpPost("federated/refresh")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<FederatedReport>> RefreshFederated(CancellationToken cancellationToken)
        => await _federated.RunPassAsync(cancellationToken).ConfigureAwait(false);
}

/// <summary>Body of <c>POST /mesh/groups</c>.</summary>
public sealed class CreateGroupRequest
{
    /// <summary>Human-readable group name.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// Optional coordinator URL, carried in every invite so members auto-configure it.
    /// </summary>
    /// <remarks>
    /// Null or empty is the zero-server default: iroh's public relays, n0 DNS and the mainline DHT,
    /// with the shared fallback coordinator appended at the lowest priority.
    /// </remarks>
    public string? Coordinator { get; set; }
}

/// <summary>Body of <c>POST /mesh/groups/join</c>.</summary>
public sealed class JoinGroupRequest
{
    /// <summary>The base58 invite code.</summary>
    public string Code { get; set; } = string.Empty;
}
