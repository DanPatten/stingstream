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
    private readonly ILogger<ConnectionService> _logger;

    public ConnectionService(
        IMeshClient mesh,
        SharedLibraryStore shared,
        InventoryPublisher publisher,
        InviteService invites,
        ILogger<ConnectionService> logger)
    {
        _mesh = mesh;
        _shared = shared;
        _publisher = publisher;
        _invites = invites;
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
        CancellationToken cancellationToken)
    {
        var status = await _mesh.StatusAsync(cancellationToken).ConfigureAwait(false)
            ?? throw new MeshException("The mesh is not answering.");

        var group = await _mesh.CreateGroupAsync(status.ServerName, cancellationToken).ConfigureAwait(false);
        try
        {
            await _shared.SetAsync(group.Group, libraries, cancellationToken).ConfigureAwait(false);
            var invite = await _mesh.InviteAsync(group.Group, cancellationToken).ConfigureAwait(false);
            _publisher.RequestSnapshot();
            return new ConnectionInvite
            {
                Code = invite.Code,
                Node = status.Node,
                Server = status.ServerName,
            };
        }
        catch (Exception)
        {
            await AbandonAsync(group.Group).ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>Use an invite another server made, sharing <paramref name="libraries"/> back.</summary>
    /// <param name="code">The code from the invite link.</param>
    /// <param name="libraries">What this server shares.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The connection.</returns>
    public async Task<MeshJoinResult> ConnectAsync(
        string code,
        IReadOnlyList<Guid> libraries,
        CancellationToken cancellationToken)
    {
        var joined = await _mesh.JoinGroupAsync(code.Trim(), cancellationToken).ConfigureAwait(false);
        await _shared.SetAsync(joined.Group, libraries, cancellationToken).ConfigureAwait(false);
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
            return "This invitation has expired. Ask for a new invite link.";
        }

        if (text.Contains("already been used", StringComparison.OrdinalIgnoreCase))
        {
            return "This invitation has already been used. Ask for a new invite link.";
        }

        if (text.Contains("no such invite", StringComparison.OrdinalIgnoreCase)
            || text.Contains("not valid", StringComparison.OrdinalIgnoreCase))
        {
            return "This invite link is not valid. Ask for a new one.";
        }

        return "The other server could not be reached. Check that it is online and try again.";
    }

    private async Task AbandonAsync(string group)
    {
        try
        {
            await _mesh.LeaveGroupAsync(group, CancellationToken.None).ConfigureAwait(false);
            await _shared.RemoveAsync(group, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not remove the unfinished connection {Group}", group);
        }
    }
}
