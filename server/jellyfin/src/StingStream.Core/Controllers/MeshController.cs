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
    private readonly Sharing.SharedLibraryStore _shared;
    private readonly Invites.InviteService _invites;
    private readonly Mesh.InventoryPublisher _publisher;

    public MeshController(
        IMeshClient mesh,
        FederatedLibraryService federated,
        Sharing.SharedLibraryStore shared,
        Invites.InviteService invites,
        Mesh.InventoryPublisher publisher)
    {
        _mesh = mesh;
        _federated = federated;
        _shared = shared;
        _invites = invites;
        _publisher = publisher;
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

    /// <summary>Every member of a group, removed ones included.</summary>
    /// <param name="group">The group id, hex.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The membership.</response>
    /// <response code="503">The mesh is not answering.</response>
    /// <returns>The membership.</returns>
    /// <remarks>
    /// Elevated, unlike <see cref="Groups"/>: the list is node ids and last-seen times for every
    /// machine in the group, which is more than a member needs in order to watch a film, and it is
    /// the screen the Remove button lives on.
    /// </remarks>
    [HttpGet("groups/{group}/members")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<MeshMembers>> Members(
        [FromRoute] string group,
        CancellationToken cancellationToken)
    {
        var members = await _mesh.MembersAsync(group, cancellationToken).ConfigureAwait(false);
        return members is null ? MeshUnavailable() : Ok(members);
    }

    /// <summary>Remove a member from a group and rotate the group's secret.</summary>
    /// <param name="group">The group id, hex.</param>
    /// <param name="node">The member's node id, hex.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">What the rotation did.</response>
    /// <response code="400">This node is not in that group, or that is not a node id.</response>
    /// <response code="503">The mesh is not answering.</response>
    /// <returns>What the rotation did.</returns>
    /// <remarks>
    /// This is a group-wide, irreversible act performed from one member's node: every remaining
    /// member gets a new secret, every invite code minted before now stops working, and the removed
    /// node is refused from this moment. There is no un-remove — the node re-joins from a fresh
    /// invite like anybody else. See <c>docs/MESH.md</c>.
    ///
    /// The call can take minutes on a group where several members are asleep, because it waits to
    /// report who actually took the new secret. The ones it could not reach are not a failure: they
    /// catch up on their next connection through the grace window.
    /// </remarks>
    [HttpDelete("groups/{group}/members/{node}")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<MeshRotation>> RemoveMember(
        [FromRoute] string group,
        [FromRoute] string node,
        CancellationToken cancellationToken)
        => Ok(await _mesh.RemoveMemberAsync(group, node, cancellationToken).ConfigureAwait(false));

    /// <summary>Rotate a group's secret, keeping every member.</summary>
    /// <param name="group">The group id, hex.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">What the rotation did.</response>
    /// <response code="400">This node is not in that group.</response>
    /// <response code="503">The mesh is not answering.</response>
    /// <returns>What the rotation did.</returns>
    /// <remarks>
    /// For when a code leaked rather than when a person left. Nobody is removed; every invite
    /// minted before now stops working, and every member has to be handed the new secret, which
    /// happens automatically for the ones that are reachable and on their next dial for the rest.
    /// </remarks>
    [HttpPost("groups/{group}/rotate")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<MeshRotation>> RotateSecret(
        [FromRoute] string group,
        CancellationToken cancellationToken)
        => Ok(await _mesh.RotateSecretAsync(group, cancellationToken).ConfigureAwait(false));

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
        return await _mesh.CreateGroupAsync(body.Name, cancellationToken).ConfigureAwait(false);
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

    /// <summary>Mint an invite.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The invite code, and a link when this node has a host for one.</response>
    /// <returns>The invite.</returns>
    [HttpPost("groups/{group}/invite")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<MeshInvite>> Invite(string group, CancellationToken cancellationToken)
        => await _mesh.InviteAsync(group, cancellationToken).ConfigureAwait(false);

    /// <summary>Read this node's sharing settings.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The settings, with nulls where nothing is configured.</response>
    /// <returns>The settings.</returns>
    [HttpGet("settings/sharing")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<MeshSharingSettings>> SharingSettings(CancellationToken cancellationToken)
        => await _mesh.SharingSettingsAsync(cancellationToken).ConfigureAwait(false);

    /// <summary>Write this node's sharing settings.</summary>
    /// <param name="body">Both fields; null clears one.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The settings as stored, normalised.</response>
    /// <returns>The settings as stored.</returns>
    /// <remarks>
    /// Both fields go together rather than one endpoint each. The page shows both, an absent field
    /// means "cleared", and a partial update would make "the user emptied this box" impossible to
    /// tell from "this client is older than this node and does not know the field exists".
    /// </remarks>
    [HttpPut("settings/sharing")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<MeshSharingSettings>> SetSharingSettings(
        [FromBody] MeshSharingSettings body,
        CancellationToken cancellationToken)
        => await _mesh.SetSharingSettingsAsync(body, cancellationToken).ConfigureAwait(false);


    /// <summary>Whether a browser can reach this server, and how.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The status, with an empty tunnel when nothing is set up.</response>
    /// <returns>The status.</returns>
    /// <remarks>
    /// Elevated, like everything else here — and deliberately not served by the node's own
    /// <c>/healthz</c>, which is redacted for off-machine callers. A browser reaching this server
    /// through the very tunnel this page set up has to be able to read the page that set it up.
    /// </remarks>
    [HttpGet("domains")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<MeshDomains>> Domains(CancellationToken cancellationToken)
        => await _mesh.DomainsAsync(cancellationToken).ConfigureAwait(false);

    /// <summary>Ask this server to run a Cloudflare Tunnel.</summary>
    /// <param name="body">Which kind, and the hostname and token a named one needs.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The status, which will say starting.</response>
    /// <returns>The status.</returns>
    /// <remarks>
    /// Answers as soon as the request is recorded rather than waiting for Cloudflare: the node's
    /// supervisor picks it up on its next reconcile, so this returns in milliseconds and the page
    /// polls. The API token is write-only and is never stored.
    /// </remarks>
    [HttpPost("domains/tunnel")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<MeshDomains>> SetTunnel(
        [FromBody] MeshTunnelRequest body,
        CancellationToken cancellationToken)
        => await _mesh.SetTunnelAsync(body, cancellationToken).ConfigureAwait(false);

    /// <summary>Stop this server's tunnel and forget it.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The status, with the tunnel off.</response>
    /// <returns>The status.</returns>
    [HttpDelete("domains/tunnel")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<MeshDomains>> DeleteTunnel(CancellationToken cancellationToken)
        => await _mesh.DeleteTunnelAsync(cancellationToken).ConfigureAwait(false);

    /// <summary>Which of this server's libraries are shared into one link, and which exist.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The choice, and everything it could be.</response>
    /// <returns>The shared libraries and the available ones.</returns>
    /// <remarks>
    /// Both halves in one answer because the screen shows one list with checkmarks, and two
    /// requests to draw one list is two chances for them to disagree.
    /// </remarks>
    [HttpGet("groups/{group}/libraries", Name = "GetSharedLibraries")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<SharedLibraries>> SharedLibraries(
        string group,
        CancellationToken cancellationToken)
        => new SharedLibraries
        {
            Shared = await _shared.GetAsync(group, cancellationToken).ConfigureAwait(false),
            Available = _invites.Libraries(),
        };

    /// <summary>Choose which of this server's libraries are shared into one link.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="body">The whole list. Empty shares nothing.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">Stored, and republished.</response>
    /// <returns>The choice as stored.</returns>
    /// <remarks>
    /// <para>
    /// A whole-list write: an absent id is how a library is un-shared, so a partial update could
    /// not tell "the owner removed this one" from "the client did not mention it".
    /// </para>
    /// <para>
    /// A snapshot is forced rather than waited for. A snapshot <em>replaces</em> this node's rows
    /// on every peer, so it is what actually retracts a library the owner has just un-shared —
    /// waiting up to fifteen minutes for the periodic one would mean the screen said "no longer
    /// shared" while the other server still listed the films.
    /// </para>
    /// </remarks>
    [HttpPut("groups/{group}/libraries", Name = "SetSharedLibraries")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<SharedLibraries>> SetSharedLibraries(
        string group,
        [FromBody] SetSharedLibrariesRequest body,
        CancellationToken cancellationToken)
    {
        var libraries = body?.Libraries ?? Array.Empty<Guid>();
        await _shared.SetAsync(group, libraries, cancellationToken).ConfigureAwait(false);
        _publisher.RequestSnapshot();
        return new SharedLibraries
        {
            Shared = libraries,
            Available = _invites.Libraries(),
        };
    }

    /// <summary>Leave a group.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Left.</response>
    /// <response code="404">This node is not a member of that group.</response>
    /// <returns>No content.</returns>
    /// <remarks>
    /// The share list goes with it. <see cref="Sharing.SharedLibraryStore.RemoveAsync"/> had no
    /// caller at all, so leaving left the row behind — harmless while a group id was never seen
    /// again, and not harmless now that one link is one server: the tidy way back from a link that
    /// went wrong is to leave it and add the server again, and a stale row would decide what the
    /// new link shares before anybody had been asked.
    /// </remarks>
    [HttpDelete("groups/{group}")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> Leave(string group, CancellationToken cancellationToken)
    {
        if (!await _mesh.LeaveGroupAsync(group, cancellationToken).ConfigureAwait(false))
        {
            return NotFound();
        }

        await _shared.RemoveAsync(group, cancellationToken).ConfigureAwait(false);
        return NoContent();
    }

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
    [HttpGet("groups/{group}/sources/{itemKey}", Name = "GetMeshSources")]
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

}

/// <summary>Body of <c>POST /mesh/groups/join</c>.</summary>
public sealed class JoinGroupRequest
{
    /// <summary>The base58 invite code.</summary>
    public string Code { get; set; } = string.Empty;
}
