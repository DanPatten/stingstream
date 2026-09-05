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
        return status is null ? MeshUnavailable() : Ok(status);
    }

    /// <summary>Every group this node belongs to.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The groups.</response>
    /// <response code="503">The mesh is not answering.</response>
    /// <returns>The groups.</returns>
    [HttpGet("groups")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<IReadOnlyList<MeshGroup>>> Groups(CancellationToken cancellationToken)
    {
        var groups = await _mesh.GroupsAsync(cancellationToken).ConfigureAwait(false);
        return groups is null ? MeshUnavailable() : Ok(groups);
    }

    /// <summary>
    /// The one answer for "the mesh did not answer".
    /// </summary>
    /// <remarks>
    /// A 503 rather than an empty list, because a caller that cannot tell the two apart draws the
    /// wrong conclusion — the app would show an empty Group screen, and the federated materializer
    /// would delete every pointer on the node.
    /// </remarks>
    private ActionResult MeshUnavailable()
        => StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "the mesh is not answering" });

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
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<MeshIndex>> Index(string group, CancellationToken cancellationToken)
    {
        var index = await _mesh.IndexAsync(group, cancellationToken).ConfigureAwait(false);
        return index is null ? MeshUnavailable() : Ok(index);
    }

    /// <summary>Group membership, liveness, observed path and advertised capacity.</summary>
    /// <param name="group">The group id, or omit for every group.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The peers.</response>
    /// <returns>The peers.</returns>
    [HttpGet("peers")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<IReadOnlyList<MeshPeer>>> Peers(
        [FromQuery] string? group,
        CancellationToken cancellationToken)
    {
        var peers = await _mesh.PeersAsync(group, cancellationToken).ConfigureAwait(false);
        return peers is null ? MeshUnavailable() : Ok(peers);
    }

    /// <summary>
    /// One peer's measured link, as the source scorer sees it.
    /// </summary>
    /// <param name="node">The peer's node id.</param>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The peer row, including its rolling measured throughput.</response>
    /// <response code="404">This node has never seen that peer in that group.</response>
    /// <returns>The peer row.</returns>
    /// <remarks>
    /// Separate from <c>GET /mesh/peers</c> because this is the *measurement*, not the membership:
    /// it is what a scorer weighs, what the Node status screen would show as "12 Mbit/s from loft",
    /// and the first thing a support question about a slow stream needs.
    ///
    /// <c>throughputBps</c> is null until this node has actually pulled enough bytes from the peer
    /// for a sample to mean anything — the mesh discards transfers under 256 KiB or 100 ms, because
    /// a 64 KiB seek that finished in 8 ms is arithmetically 65 Mbit/s and says nothing about
    /// whether a film will stream.
    /// </remarks>
    [HttpGet("peers/{node}/stats")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<MeshPeer>> PeerStats(
        string node,
        [FromQuery] string group,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(group))
        {
            return BadRequest(new { error = "?group= is required" });
        }

        var stats = await _mesh.PeerStatsAsync(group, node, cancellationToken).ConfigureAwait(false);
        return stats is null
            ? NotFound(new { error = $"this node has never seen {node} in that group" })
            : Ok(stats);
    }

    /// <summary>
    /// Every holder of an item, scored, best first, with the reasons.
    /// </summary>
    /// <param name="group">The group id.</param>
    /// <param name="itemKey">The item key.</param>
    /// <param name="policy">Score under this policy; defaults to Speed first.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The mesh's own scored candidate list.</response>
    /// <returns>The scored sources.</returns>
    /// <remarks>
    /// The <em>mesh's</em> answer, which is the one <c>?any=1</c> and mid-stream failover act on.
    /// <c>GET /items/{id}/sources</c> is Core's answer to the same question under the user's stored
    /// policy, and is what the app should read; this exists so the two can be compared when they
    /// disagree, which is the failure mode of keeping one formula in two languages.
    /// </remarks>
    [HttpGet("groups/{group}/sources/{itemKey}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<MeshSources>> Sources(
        string group,
        string itemKey,
        [FromQuery] string? policy,
        CancellationToken cancellationToken)
    {
        var chosen = Playback.PolicyNames.Parse(policy) ?? Playback.PlaybackPolicy.SpeedFirst;
        var sources = await _mesh.SourcesAsync(group, itemKey, chosen, cancellationToken).ConfigureAwait(false);
        return sources is null ? MeshUnavailable() : Ok(sources);
    }

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
