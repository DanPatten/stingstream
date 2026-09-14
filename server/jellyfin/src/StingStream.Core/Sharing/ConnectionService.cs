using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Invites;
using StingStream.Core.Mesh;

namespace StingStream.Core.Sharing;

/// <summary>An invite link's contents, as the server that made it hands them out.</summary>
public sealed class ConnectionInvite
{
    /// <summary>The single-use mesh code.</summary>
    public string Code { get; set; } = string.Empty;

    /// <summary>This node's id, so the page that opens the link can tell whose link it is.</summary>
    public string Node { get; set; } = string.Empty;

    /// <summary>This server's name, for the page that opens the link.</summary>
    public string Server { get; set; } = string.Empty;

    /// <summary>The group the invite joins, so the page that shows the link can cancel it.</summary>
    public string Group { get; set; } = string.Empty;

    /// <summary>
    /// The origin to put the link on: the domain when one is set, this machine's LAN address when
    /// not, null when neither is known and the page falls back to however it reached this server.
    /// </summary>
    public string? Address { get; set; }
}

/// <summary>
/// The two halves of connecting servers: make an invite, and use one.
/// </summary>
/// <remarks>
/// <para>
/// Dan: <em>"one user does EVERYTHING once and they are done. The other user does everything once and
/// they are done - there isnt any more back and forth."</em> So each half is one call that does
/// everything its side needs: choosing what this server shares is part of making or using the
/// invite, never a separate step on a separate page afterwards.
/// </para>
/// <para>
/// Shared by <c>ConnectionsController</c> and by <c>IdentityService</c>, which uses an invite on
/// behalf of somebody signing in with their own server for the first time.
/// </para>
/// </remarks>
public sealed class ConnectionService
{
    private readonly IMeshClient _mesh;
    private readonly SharedLibraryStore _shared;
    private readonly InventoryPublisher _publisher;
    private readonly InviteService _invites;
    private readonly ConnectionStore _records;
    private readonly ILogger<ConnectionService> _logger;

    public ConnectionService(
        IMeshClient mesh,
        SharedLibraryStore shared,
        InventoryPublisher publisher,
        InviteService invites,
        ConnectionStore records,
        ILogger<ConnectionService> logger)
    {
        _mesh = mesh;
        _shared = shared;
        _publisher = publisher;
        _invites = invites;
        _records = records;
        _logger = logger;
    }

    /// <summary>Make an invite that shares <paramref name="libraries"/> with whoever uses it.</summary>
    /// <param name="libraries">What this server shares.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The invite.</returns>
    /// <remarks>
    /// One group per connection, named after this server, so the other side lists it under the name
    /// it knows. If any step after creating the group fails the group is removed again: an empty
    /// connection nobody can open would sit on the Servers page until it expired.
    /// </remarks>
    public async Task<ConnectionInvite> CreateInviteAsync(
        IReadOnlyList<Guid> libraries,
        CancellationToken cancellationToken,
        string? connectedBy = null)
    {
        var status = await _mesh.StatusAsync(cancellationToken).ConfigureAwait(false)
            ?? throw new MeshException("The mesh is not answering.");

        var group = await _mesh.CreateGroupAsync(status.ServerName, cancellationToken).ConfigureAwait(false);
        try
        {
            await _shared.SetAsync(group.Group, libraries, cancellationToken).ConfigureAwait(false);
            await _records.SaveAsync(group.Group, null, connectedBy, cancellationToken).ConfigureAwait(false);
            var invite = await _mesh.InviteAsync(group.Group, cancellationToken).ConfigureAwait(false);
            _publisher.RequestSnapshot();
            return new ConnectionInvite
            {
                Code = invite.Code,
                Node = status.Node,
                Server = status.ServerName,
                Group = group.Group,
                Address = await AddressAsync(status, cancellationToken).ConfigureAwait(false),
            };
        }
        catch (Exception)
        {
            await AbandonAsync(group.Group).ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>A fresh code for a connection this server already made, or null when it has no such group.</summary>
    /// <param name="group">The group the pending invite created.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The invite.</returns>
    /// <remarks>
    /// The Servers page lists an invite nobody has used yet, and pressing it shows the link again.
    /// The mesh keeps only a hash of each code, so the original cannot be read back; a new code for
    /// the same group is the same invite as far as anybody can tell. The libraries were chosen when
    /// the group was made and stay as they are. Earlier codes keep working until one is used.
    /// </remarks>
    public async Task<ConnectionInvite?> ReissueInviteAsync(string group, CancellationToken cancellationToken)
    {
        var groups = await _mesh.GroupsAsync(cancellationToken).ConfigureAwait(false);
        if (groups?.Any(g => string.Equals(g.Group, group, StringComparison.OrdinalIgnoreCase)) != true)
        {
            return null;
        }

        var status = await _mesh.StatusAsync(cancellationToken).ConfigureAwait(false)
            ?? throw new MeshException("The mesh is not answering.");
        var invite = await _mesh.InviteAsync(group, cancellationToken).ConfigureAwait(false);
        return new ConnectionInvite
        {
            Code = invite.Code,
            Node = status.Node,
            Server = status.ServerName,
            Group = group,
            Address = await AddressAsync(status, cancellationToken).ConfigureAwait(false),
        };
    }

    /// <summary>
    /// Where an invite link should point: the domain if there is one, the LAN address if not.
    /// </summary>
    /// <remarks>
    /// The same order, and for the same reason, as the account invite links in
    /// <c>InviteService.BuildLinkAsync</c>. Dan: <em>"when generating ANY invite links always use the
    /// domain name if set"</em>. The page used to choose, and it only knew the LAN address.
    /// </remarks>
    private async Task<string?> AddressAsync(MeshStatus status, CancellationToken cancellationToken)
    {
        try
        {
            var settings = await _mesh.SharingSettingsAsync(cancellationToken).ConfigureAwait(false);
            var host = settings?.PublicAddress?.Trim().TrimEnd('/');
            if (!string.IsNullOrEmpty(host))
            {
                return host;
            }
        }
        catch (Exception ex) when (ex is MeshException or System.Net.Http.HttpRequestException or TaskCanceledException)
        {
            _logger.LogWarning(ex, "Could not read this node's public address for an invite link");
        }

        var lan = status.DecodeSideDoor()?.First("lan-ip-http")?.Url?.TrimEnd('/');
        return string.IsNullOrEmpty(lan) ? null : lan;
    }

    /// <summary>Use an invite another server made, sharing <paramref name="libraries"/> back.</summary>
    /// <param name="code">The code from the invite link.</param>
    /// <param name="libraries">What this server shares.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The connection.</returns>
    /// <remarks>
    /// <paramref name="address"/> is the other server's, from the invite link. Saving it here is what
    /// puts it on the Servers page the moment this returns, before that server's first heartbeat.
    /// A malformed one is dropped rather than failing a connection that has already been made.
    /// </remarks>
    public async Task<MeshJoinResult> ConnectAsync(
        string code,
        IReadOnlyList<Guid> libraries,
        CancellationToken cancellationToken,
        string? address = null,
        string? connectedBy = null)
    {
        var joined = await _mesh.JoinGroupAsync(code.Trim(), cancellationToken).ConfigureAwait(false);
        await _shared.SetAsync(joined.Group, libraries, cancellationToken).ConfigureAwait(false);
        ConnectionStore.TryNormalizeAddress(address, out var origin);
        await _records.SaveAsync(joined.Group, origin, connectedBy, cancellationToken).ConfigureAwait(false);
        _publisher.RequestSnapshot();
        _logger.LogInformation("Connected to {Server}", joined.Name);
        return joined;
    }

    /// <summary>Every library on this server, for a connection that shares all of them.</summary>
    /// <returns>The library ids.</returns>
    public IReadOnlyList<Guid> AllLibraries()
        => _invites.Libraries()
            .Select(l => Guid.TryParse(l.Id, out var id) ? id : Guid.Empty)
            .Where(id => !id.Equals(Guid.Empty))
            .ToArray();

    /// <summary>
    /// The sentence to show for a failed attempt, written for the person reading it.
    /// </summary>
    /// <param name="error">What went wrong.</param>
    /// <returns>One sentence.</returns>
    /// <remarks>
    /// The mesh's own message names child processes and carries a context chain, which belongs in
    /// the log, not on a screen.
    /// </remarks>
    public static string Explain(Exception error)
    {
        var text = error?.Message ?? string.Empty;
        if (text.Contains("expired", StringComparison.OrdinalIgnoreCase))
        {
            return "This invite link has expired. Ask the sender for a new one.";
        }

        if (text.Contains("already been used", StringComparison.OrdinalIgnoreCase))
        {
            return "This invite link has already been used. Ask the sender for a new one.";
        }

        if (text.Contains("no such invite", StringComparison.OrdinalIgnoreCase)
            || text.Contains("not valid", StringComparison.OrdinalIgnoreCase))
        {
            return "This invite link is not valid. Ask the sender for a new one.";
        }

        return "The other server could not be reached. Make sure it is online and try again.";
    }

    private async Task AbandonAsync(string group)
    {
        try
        {
            await _mesh.LeaveGroupAsync(group, CancellationToken.None).ConfigureAwait(false);
            await _shared.RemoveAsync(group, CancellationToken.None).ConfigureAwait(false);
            await _records.RemoveAsync(group, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not remove the unfinished connection {Group}", group);
        }
    }
}
