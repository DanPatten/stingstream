using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;

namespace StingStream.Core.Mesh;

/// <summary>Talks to this node's mesh over its loopback API.</summary>
public interface IMeshClient
{
    /// <summary>The mesh's base URL, or null when this node has no mesh.</summary>
    string? BaseUrl { get; }

    /// <summary>True when the mesh answered its health endpoint recently.</summary>
    bool IsAvailable { get; }

    /// <summary>Wait until the mesh answers <c>/healthz</c>, or the timeout elapses.</summary>
    /// <param name="timeout">How long to wait.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when the mesh answered.</returns>
    Task<bool> WaitUntilReadyAsync(TimeSpan timeout, CancellationToken cancellationToken);

    /// <summary>This node's mesh identity and addresses.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The status, or null when the mesh is unreachable.</returns>
    Task<MeshStatus?> StatusAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Every group this node belongs to, or <see langword="null"/> when the mesh could not be
    /// asked.
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The groups, or null.</returns>
    /// <remarks>
    /// Null and empty mean genuinely different things here, which is why this is nullable at all.
    /// "This node belongs to no groups" tells the federated materializer to take every pointer
    /// down; "the mesh did not answer" must not. Collapsing the two would mean one restart of the
    /// mesh process deletes a node's whole Shared library.
    /// </remarks>
    Task<IReadOnlyList<MeshGroup>?> GroupsAsync(CancellationToken cancellationToken);

    /// <summary>Create a group.</summary>
    /// <param name="name">Human-readable group name.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The new group.</returns>
    Task<MeshGroup> CreateGroupAsync(string name, CancellationToken cancellationToken);

    /// <summary>Join a group from an invite code.</summary>
    /// <param name="code">The invite code.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>What the join reached.</returns>
    Task<MeshJoinResult> JoinGroupAsync(string code, CancellationToken cancellationToken);

    /// <summary>Mint an invite for a group.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The invite code, and the link to hand out instead when this node has a host.</returns>
    Task<MeshInvite> InviteAsync(string group, CancellationToken cancellationToken);

    /// <summary>Sign a statement about one of this node's people, for another node.</summary>
    /// <param name="audience">Node id of the server the assertion is for.</param>
    /// <param name="nonce">That server's own challenge.</param>
    /// <param name="userId">The user's id on this server.</param>
    /// <param name="userName">Their username here.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The assertion, and who signed it.</returns>
    Task<MeshVouch> VouchAsync(
        string audience,
        string nonce,
        string userId,
        string userName,
        CancellationToken cancellationToken);

    /// <summary>Check an assertion somebody presented, and read what it claims.</summary>
    /// <param name="assertion">The assertion.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The claims, or null when it is not genuine or is not addressed to this node.</returns>
    /// <remarks>
    /// A null rather than an exception for the ordinary refusal, because "that is not a valid
    /// assertion" is an answer this route exists to give — the caller turns it into a 401 with a
    /// sentence. A transport failure still throws, because a mesh that is down is not the same as
    /// an assertion that is bad and must not be reported as one.
    /// </remarks>
    Task<MeshVouchClaims?> VerifyVouchAsync(string assertion, CancellationToken cancellationToken);

    /// <summary>Which account service this server uses, and whose account it belongs to.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The account status.</returns>
    Task<MeshAccountStatus> AccountStatusAsync(CancellationToken cancellationToken);

    /// <summary>Create a StingStream account, or attach this server to one.</summary>
    /// <param name="username">The username.</param>
    /// <param name="password">The password.</param>
    /// <param name="claim">True to attach to an account that already exists.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The account status.</returns>
    Task<MeshAccountStatus> AccountRegisterAsync(
        string username,
        string password,
        bool claim,
        CancellationToken cancellationToken);

    /// <summary>Set a new password on the account this server belongs to.</summary>
    /// <param name="password">The new password.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The account status.</returns>
    Task<MeshAccountStatus> AccountResetAsync(string password, CancellationToken cancellationToken);

    /// <summary>Check an account token. Local to the node; no network.</summary>
    /// <param name="token">The token from the account service.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Who the token says its holder is.</returns>
    Task<MeshAccountSession> AccountVerifyAsync(string token, CancellationToken cancellationToken);

    /// <summary>Read this node's sharing settings.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The settings, with nulls where nothing is configured.</returns>
    Task<MeshSharingSettings> SharingSettingsAsync(CancellationToken cancellationToken);

    /// <summary>Write this node's sharing settings, both fields together.</summary>
    /// <param name="settings">The values to store; null clears a field.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The settings as stored, normalised.</returns>
    Task<MeshSharingSettings> SetSharingSettingsAsync(
        MeshSharingSettings settings,
        CancellationToken cancellationToken);

    /// <summary>Tell the running mesh what this server is called now.</summary>
    /// <param name="serverName">The new name. Blank is ignored by the node.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    /// <remarks>
    /// A node has one name and it is the server's. <c>runtime.json</c> is what makes a rename
    /// survive a restart; this is what makes it arrive without one, by republishing into every
    /// link so peers stop showing the old name.
    /// </remarks>
    Task SetServerNameAsync(string serverName, CancellationToken cancellationToken);


    /// <summary>Whether a browser can reach this node, and how.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The status, with an empty tunnel when nothing is set up.</returns>
    Task<MeshDomains> DomainsAsync(CancellationToken cancellationToken);

    /// <summary>Ask this node to run a Cloudflare Tunnel.</summary>
    /// <param name="request">Which kind, and the hostname and token a named one needs.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The status, which will say <c>starting</c>.</returns>
    Task<MeshDomains> SetTunnelAsync(
        MeshTunnelRequest request,
        CancellationToken cancellationToken);

    /// <summary>Stop this node's tunnel and forget it.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The status, with the tunnel off.</returns>
    Task<MeshDomains> DeleteTunnelAsync(CancellationToken cancellationToken);

    /// <summary>Every member of a group, removed ones included.</summary>
    /// <param name="group">The group id, hex.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The membership, or null when the mesh is not answering.</returns>
    Task<MeshMembers?> MembersAsync(string group, CancellationToken cancellationToken);

    /// <summary>Remove a member from a group and rotate the group's secret.</summary>
    /// <param name="group">The group id, hex.</param>
    /// <param name="node">The member's node id, hex.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>What the rotation did.</returns>
    Task<MeshRotation> RemoveMemberAsync(string group, string node, CancellationToken cancellationToken);

    /// <summary>Rotate a group's secret without removing anybody.</summary>
    /// <param name="group">The group id, hex.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>What the rotation did.</returns>
    Task<MeshRotation> RotateSecretAsync(string group, CancellationToken cancellationToken);

    /// <summary>Leave a group.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when the node was a member.</returns>
    Task<bool> LeaveGroupAsync(string group, CancellationToken cancellationToken);

    /// <summary>Replace this node's whole inventory for a group.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="records">The full snapshot.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    Task PutInventoryAsync(string group, IReadOnlyList<MeshInventoryRecord> records, CancellationToken cancellationToken);

    /// <summary>Apply a delta to this node's inventory for a group.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="upserts">Records to add or replace.</param>
    /// <param name="removals">Item keys to drop.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    Task PatchInventoryAsync(
        string group,
        IReadOnlyList<MeshInventoryRecord> upserts,
        IReadOnlyList<string> removals,
        CancellationToken cancellationToken);

    /// <summary>Publish this node's advertised capacity, which rides the gossip heartbeat.</summary>
    /// <param name="capacity">The capacity.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    Task PutCapacityAsync(MeshCapacity capacity, CancellationToken cancellationToken);

    /// <summary>
    /// The merged group index, or <see langword="null"/> when the mesh could not be asked.
    /// </summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The index, or null.</returns>
    /// <remarks>Nullable for the same reason as <see cref="GroupsAsync"/>.</remarks>
    Task<MeshIndex?> IndexAsync(string group, CancellationToken cancellationToken);

    /// <summary>
    /// Group membership and liveness, or <see langword="null"/> when the mesh could not be asked.
    /// </summary>
    /// <param name="group">The group id, or null for every group.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The peers, or null.</returns>
    /// <remarks>
    /// Nullable for the same reason as <see cref="GroupsAsync"/>: an unanswered call would
    /// otherwise read as "every peer is offline", which starts a grace period on every title in
    /// the group.
    /// </remarks>
    Task<IReadOnlyList<MeshPeer>?> PeersAsync(string? group, CancellationToken cancellationToken);

    /// <summary>One peer's measured link, as the source scorer sees it.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="node">The peer's node id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The peer row, or null when the mesh cannot be asked or has never seen it.</returns>
    Task<MeshPeer?> PeerStatsAsync(string group, string node, CancellationToken cancellationToken);

    /// <summary>The mesh's own scored candidate list for an item.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="itemKey">The item key.</param>
    /// <param name="policy">The playback policy to score under.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The scored sources, or null when the mesh could not be asked.</returns>
    Task<MeshSources?> SourcesAsync(
        string group,
        string itemKey,
        Playback.PlaybackPolicy policy,
        CancellationToken cancellationToken);

    /// <summary>
    /// Read a byte range of a peer's file through the mesh, for a pin.
    /// </summary>
    /// <param name="group">The group id.</param>
    /// <param name="itemKey">The item key.</param>
    /// <param name="node">The holding node's id, or <c>any</c> to let the mesh choose.</param>
    /// <param name="from">First byte wanted.</param>
    /// <param name="to">Last byte wanted, inclusive, or null for "to the end".</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The open response; the caller disposes it and copies the body.</returns>
    /// <remarks>
    /// Returns the live <see cref="HttpResponseMessage"/> rather than bytes because a pin copies a
    /// whole film: buffering one in memory to hand it back would be a gigabyte per pin.
    /// </remarks>
    Task<HttpResponseMessage> OpenRangeAsync(
        string group,
        string itemKey,
        string node,
        long from,
        long? to,
        CancellationToken cancellationToken);

    /// <summary>Fetch one artwork file from a peer, over the mesh.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="itemKey">The item key.</param>
    /// <param name="node">The holding node's id.</param>
    /// <param name="kind">Image kind, e.g. <c>primary</c>.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The bytes and their content type, or null when the peer has no such image.</returns>
    Task<(byte[] Bytes, string? ContentType)?> ImageAsync(
        string group,
        string itemKey,
        string node,
        string kind,
        CancellationToken cancellationToken);

    /// <summary>Fetch one subtitle sidecar from a peer, by its index in that peer's list (M7).</summary>
    /// <param name="group">The group id.</param>
    /// <param name="itemKey">The item.</param>
    /// <param name="node">The holding node.</param>
    /// <param name="index">Position in the holder's published list.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The bytes, or null when the peer did not answer or holds no such subtitle.</returns>
    Task<byte[]?> SubtitleAsync(
        string group,
        string itemKey,
        string node,
        int index,
        CancellationToken cancellationToken);
}

/// <inheritdoc />
/// <remarks>
/// The read methods answer "the mesh is not there" with <see langword="null"/> and a debug log,
/// never an exception that would take a caller down: a node whose mesh has not started, or which
/// was built without one, is still a complete single-node server. **Null is not the same as
/// empty**, and the difference matters more than it looks — "this node is in no groups" tells the
/// federated materializer to take every pointer down, while "the mesh did not answer" must leave
/// them exactly where they are.
///
/// The group-lifecycle calls are the exception and throw, because they are only ever reached from
/// an explicit API request and the user deserves to be told it did not happen.
/// </remarks>
public sealed class MeshClient : IMeshClient
{
    /// <summary>Named <see cref="IHttpClientFactory"/> client for mesh calls.</summary>
    public const string HttpClientName = "stingstream-mesh";

    /// <summary>The mesh's documented default local API port (<c>docs/MESH.md</c>).</summary>
    public const int DefaultApiPort = 8791;

    private readonly INodeRuntimeProvider _runtime;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<MeshClient> _logger;

    private DateTime _lastOkUtc = DateTime.MinValue;

    public MeshClient(
        INodeRuntimeProvider runtime,
        IHttpClientFactory httpFactory,
        ILogger<MeshClient> logger)
    {
        _runtime = runtime;
        _httpFactory = httpFactory;
        _logger = logger;
    }

    /// <inheritdoc />
    public string? BaseUrl
    {
        get
        {
            var port = ResolvePort();
            return port > 0 ? string.Create(CultureInfo.InvariantCulture, $"http://127.0.0.1:{port}") : null;
        }
    }

    /// <inheritdoc />
    public bool IsAvailable => DateTime.UtcNow - _lastOkUtc < TimeSpan.FromMinutes(2);

    /// <summary>
    /// Where the mesh's loopback API is.
    /// </summary>
    /// <remarks>
    /// <c>mesh.api_port</c> first, then <c>children.mesh.port</c>, then the documented default —
    /// exactly the order the mesh itself resolves it in (<c>MeshConfig::load</c>), so the two can
    /// never disagree about which port to use.
    /// </remarks>
    private int ResolvePort()
    {
        var runtime = _runtime.Current;
        if (runtime is null)
        {
            return 0;
        }

        if (runtime.Mesh.ApiPort > 0)
        {
            return runtime.Mesh.ApiPort;
        }

        var child = runtime.Child("mesh");
        if (child is { Port: > 0 })
        {
            return child.Port;
        }

        return DefaultApiPort;
    }

    private HttpClient Client()
    {
        var http = _httpFactory.CreateClient(HttpClientName);
        var baseUrl = BaseUrl ?? throw new InvalidOperationException(
            "This server has no StingStream data directory, so it cannot find the mesh. Start it "
            + "through the StingStream supervisor.");
        http.BaseAddress = new Uri(baseUrl, UriKind.Absolute);
        return http;
    }

    /// <inheritdoc />
    public async Task<bool> WaitUntilReadyAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow + timeout;
        var delay = TimeSpan.FromMilliseconds(250);
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (await PingAsync(cancellationToken).ConfigureAwait(false))
            {
                return true;
            }

            await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
            // Back off to two seconds: the mesh binds in well under a second when it is going to
            // bind at all, and the rest of this wait is for a node that is still building its
            // iroh endpoint.
            delay = TimeSpan.FromMilliseconds(Math.Min(2000, delay.TotalMilliseconds * 1.6));
        }

        return false;
    }

    private async Task<bool> PingAsync(CancellationToken cancellationToken)
    {
        if (BaseUrl is null)
        {
            return false;
        }

        try
        {
            using var http = Client();
            http.Timeout = TimeSpan.FromSeconds(5);
            using var response = await http.GetAsync("/healthz", cancellationToken).ConfigureAwait(false);
            if (response.IsSuccessStatusCode)
            {
                _lastOkUtc = DateTime.UtcNow;
                return true;
            }
        }
        catch (Exception ex) when (IsTransport(ex))
        {
            // Not up yet.
        }

        return false;
    }

    /// <inheritdoc />
    public Task<MeshStatus?> StatusAsync(CancellationToken cancellationToken)
        => TryGetAsync<MeshStatus>("/mesh/v1/status", cancellationToken);

    /// <inheritdoc />
    public async Task<IReadOnlyList<MeshGroup>?> GroupsAsync(CancellationToken cancellationToken)
        => await TryGetAsync<List<MeshGroup>>("/mesh/v1/groups", cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<MeshGroup> CreateGroupAsync(string name, CancellationToken cancellationToken)
    {
        using var http = Client();
        using var response = await http.PostAsJsonAsync(
                "/mesh/v1/groups",
                new { name },
                MeshJson.Options,
                cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "creating a group", cancellationToken).ConfigureAwait(false);
        return await ReadAsync<MeshGroup>(response, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<MeshJoinResult> JoinGroupAsync(string code, CancellationToken cancellationToken)
    {
        using var http = Client();
        // A join dials the inviter and then, if that fails, every rendezvous entry in turn. The
        // mesh bounds each dial itself, but the total is minutes in the worst case.
        http.Timeout = TimeSpan.FromMinutes(3);
        using var response = await http.PostAsJsonAsync(
                "/mesh/v1/groups/join",
                new { code },
                MeshJson.Options,
                cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "joining a group", cancellationToken).ConfigureAwait(false);
        return await ReadAsync<MeshJoinResult>(response, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<MeshInvite> InviteAsync(string group, CancellationToken cancellationToken)
    {
        using var http = Client();
        using var response = await http.PostAsync(
                $"/mesh/v1/groups/{Uri.EscapeDataString(group)}/invite",
                content: null,
                cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "minting an invite", cancellationToken).ConfigureAwait(false);
        return await ReadAsync<MeshInvite>(response, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<MeshVouch> VouchAsync(
        string audience,
        string nonce,
        string userId,
        string userName,
        CancellationToken cancellationToken)
    {
        using var http = Client();
        using var response = await http.PostAsJsonAsync(
                "/mesh/v1/identity/assert",
                new { aud = audience, nonce, sub = userId, name = userName },
                MeshJson.Options,
                cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "signing an identity assertion", cancellationToken)
            .ConfigureAwait(false);
        return await ReadAsync<MeshVouch>(response, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<MeshVouchClaims?> VerifyVouchAsync(
        string assertion,
        CancellationToken cancellationToken)
    {
        using var http = Client();
        using var response = await http.PostAsJsonAsync(
                "/mesh/v1/identity/verify",
                new { assertion },
                MeshJson.Options,
                cancellationToken)
            .ConfigureAwait(false);

        // The mesh answers 401 for an assertion that is not genuine, expired, or addressed to
        // somebody else. That is a verdict, not a fault, and the caller needs to tell it apart from
        // "the mesh is not running" -- which ThrowIfFailedAsync still turns into an exception.
        if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            return null;
        }

        await ThrowIfFailedAsync(response, "checking an identity assertion", cancellationToken)
            .ConfigureAwait(false);
        return await ReadAsync<MeshVouchClaims>(response, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<MeshAccountStatus> AccountStatusAsync(CancellationToken cancellationToken)
        => await TryGetAsync<MeshAccountStatus>("/mesh/v1/accounts", cancellationToken)
                .ConfigureAwait(false)
            // A node too old to know the route has no account, which is what an empty status says.
            ?? new MeshAccountStatus();

    /// <inheritdoc />
    public async Task<MeshAccountStatus> AccountRegisterAsync(
        string username,
        string password,
        bool claim,
        CancellationToken cancellationToken)
    {
        using var http = Client();
        // Registering reaches the account service and waits for it, and argon2 is deliberately slow
        // on the far end. The default timeout is for loopback calls, which this is not really.
        http.Timeout = TimeSpan.FromSeconds(60);
        using var response = await http.PostAsJsonAsync(
                "/mesh/v1/accounts/register",
                new { username, password, claim },
                MeshJson.Options,
                cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "creating a StingStream account", cancellationToken)
            .ConfigureAwait(false);
        return await ReadAsync<MeshAccountStatus>(response, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<MeshAccountStatus> AccountResetAsync(
        string password,
        CancellationToken cancellationToken)
    {
        using var http = Client();
        http.Timeout = TimeSpan.FromSeconds(60);
        using var response = await http.PostAsJsonAsync(
                "/mesh/v1/accounts/reset",
                new { password },
                MeshJson.Options,
                cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "resetting the account password", cancellationToken)
            .ConfigureAwait(false);
        return await ReadAsync<MeshAccountStatus>(response, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<MeshAccountSession> AccountVerifyAsync(
        string token,
        CancellationToken cancellationToken)
    {
        using var http = Client();
        using var response = await http.PostAsJsonAsync(
                "/mesh/v1/accounts/session",
                new { token },
                MeshJson.Options,
                cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "checking an account token", cancellationToken)
            .ConfigureAwait(false);
        return await ReadAsync<MeshAccountSession>(response, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<MeshSharingSettings> SharingSettingsAsync(CancellationToken cancellationToken)
        => await TryGetAsync<MeshSharingSettings>("/mesh/v1/settings/sharing", cancellationToken)
                .ConfigureAwait(false)
            // A node too old to know the route is not an error to show anybody: nothing is
            // configured, which is exactly what an empty settings object says.
            ?? new MeshSharingSettings();

    /// <inheritdoc />
    public async Task SetServerNameAsync(string serverName, CancellationToken cancellationToken)
    {
        using var http = Client();
        using var response = await http.PutAsJsonAsync(
            "/mesh/v1/settings/server-name",
            new { server_name = serverName },
            cancellationToken).ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "renaming this server", cancellationToken)
            .ConfigureAwait(false);
    }

    public async Task<MeshSharingSettings> SetSharingSettingsAsync(
        MeshSharingSettings settings,
        CancellationToken cancellationToken)
    {
        using var http = Client();
        using var response = await http.PutAsJsonAsync(
                "/mesh/v1/settings/sharing",
                settings,
                MeshJson.Options,
                cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "saving the sharing settings", cancellationToken)
            .ConfigureAwait(false);
        return await ReadAsync<MeshSharingSettings>(response, cancellationToken).ConfigureAwait(false);
    }


    /// <inheritdoc />
    public async Task<MeshDomains> DomainsAsync(CancellationToken cancellationToken)
        => await TryGetAsync<MeshDomains>("/mesh/v1/domains", cancellationToken)
                .ConfigureAwait(false)
            // A node too old to know the route is not an error to show anybody: it has no tunnel
            // and no certificate, which is exactly what an empty object says.
            ?? new MeshDomains();

    /// <inheritdoc />
    public async Task<MeshDomains> SetTunnelAsync(
        MeshTunnelRequest request,
        CancellationToken cancellationToken)
    {
        using var http = Client();
        using var response = await http.PostAsJsonAsync(
                "/mesh/v1/domains/tunnel",
                request,
                MeshJson.Options,
                cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "setting up the tunnel", cancellationToken)
            .ConfigureAwait(false);
        return await ReadAsync<MeshDomains>(response, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<MeshDomains> DeleteTunnelAsync(CancellationToken cancellationToken)
    {
        using var http = Client();
        using var response = await http
            .DeleteAsync("/mesh/v1/domains/tunnel", cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "disconnecting the tunnel", cancellationToken)
            .ConfigureAwait(false);
        return await ReadAsync<MeshDomains>(response, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<MeshMembers?> MembersAsync(string group, CancellationToken cancellationToken)
        => await TryGetAsync<MeshMembers>(
                $"/mesh/v1/groups/{Uri.EscapeDataString(group)}/members",
                cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<MeshRotation> RemoveMemberAsync(
        string group,
        string node,
        CancellationToken cancellationToken)
    {
        using var http = Client();
        // A removal mints a new secret and then hands it to every other member in turn, each dial
        // bounded but serial. On a group of a dozen nodes where several are asleep, that is
        // minutes -- and the caller has to wait, because the answer says who actually took it.
        http.Timeout = TimeSpan.FromMinutes(3);
        using var response = await http.DeleteAsync(
                $"/mesh/v1/groups/{Uri.EscapeDataString(group)}/members/{Uri.EscapeDataString(node)}",
                cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "removing a member", cancellationToken).ConfigureAwait(false);
        return await ReadAsync<MeshRotation>(response, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<MeshRotation> RotateSecretAsync(string group, CancellationToken cancellationToken)
    {
        using var http = Client();
        http.Timeout = TimeSpan.FromMinutes(3);
        using var response = await http.PostAsync(
                $"/mesh/v1/groups/{Uri.EscapeDataString(group)}/rotate",
                content: null,
                cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "rotating the group secret", cancellationToken)
            .ConfigureAwait(false);
        return await ReadAsync<MeshRotation>(response, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<bool> LeaveGroupAsync(string group, CancellationToken cancellationToken)
    {
        using var http = Client();
        using var response = await http.DeleteAsync(
                $"/mesh/v1/groups/{Uri.EscapeDataString(group)}",
                cancellationToken)
            .ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return false;
        }

        await ThrowIfFailedAsync(response, "leaving a group", cancellationToken).ConfigureAwait(false);
        return true;
    }

    /// <inheritdoc />
    public async Task PutInventoryAsync(
        string group,
        IReadOnlyList<MeshInventoryRecord> records,
        CancellationToken cancellationToken)
    {
        using var http = Client();
        http.Timeout = TimeSpan.FromMinutes(2);
        using var response = await http.PutAsJsonAsync(
                "/mesh/v1/inventory",
                new { group, records },
                MeshJson.Options,
                cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "publishing an inventory snapshot", cancellationToken).ConfigureAwait(false);
        _lastOkUtc = DateTime.UtcNow;
    }

    /// <inheritdoc />
    public async Task PatchInventoryAsync(
        string group,
        IReadOnlyList<MeshInventoryRecord> upserts,
        IReadOnlyList<string> removals,
        CancellationToken cancellationToken)
    {
        using var http = Client();
        using var request = new HttpRequestMessage(HttpMethod.Patch, "/mesh/v1/inventory")
        {
            Content = JsonContent.Create(new { group, upserts, removals }, options: MeshJson.Options),
        };
        using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "publishing an inventory delta", cancellationToken).ConfigureAwait(false);
        _lastOkUtc = DateTime.UtcNow;
    }

    /// <inheritdoc />
    public async Task PutCapacityAsync(MeshCapacity capacity, CancellationToken cancellationToken)
    {
        using var http = Client();
        using var response = await http.PutAsJsonAsync(
                "/mesh/v1/capacity",
                capacity,
                MeshJson.Options,
                cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "publishing this node's capacity", cancellationToken).ConfigureAwait(false);
        _lastOkUtc = DateTime.UtcNow;
    }

    /// <inheritdoc />
    public async Task<MeshIndex?> IndexAsync(string group, CancellationToken cancellationToken)
        => await TryGetAsync<MeshIndex>(
            $"/mesh/v1/index?group={Uri.EscapeDataString(group)}",
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<IReadOnlyList<MeshPeer>?> PeersAsync(string? group, CancellationToken cancellationToken)
    {
        var url = string.IsNullOrWhiteSpace(group)
            ? "/mesh/v1/peers"
            : $"/mesh/v1/peers?group={Uri.EscapeDataString(group)}";
        return await TryGetAsync<List<MeshPeer>>(url, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<MeshPeer?> PeerStatsAsync(string group, string node, CancellationToken cancellationToken)
        => await TryGetAsync<MeshPeer>(
            $"/mesh/v1/peers/{Uri.EscapeDataString(node)}/stats?group={Uri.EscapeDataString(group)}",
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<MeshSources?> SourcesAsync(
        string group,
        string itemKey,
        Playback.PlaybackPolicy policy,
        CancellationToken cancellationToken)
        => await TryGetAsync<MeshSources>(
            $"/mesh/v1/sources/{Uri.EscapeDataString(group)}/{Uri.EscapeDataString(itemKey)}"
            + $"?policy={Playback.PolicyNames.Wire(policy)}",
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    /// <remarks>
    /// The <see cref="HttpClient"/> is deliberately not disposed. Clients from
    /// <see cref="IHttpClientFactory"/> are cheap wrappers over a pooled handler, and disposing one
    /// while its response body is still being read cancels the read — which is exactly what a pin
    /// does with the value this returns.
    /// </remarks>
    public async Task<HttpResponseMessage> OpenRangeAsync(
        string group,
        string itemKey,
        string node,
        long from,
        long? to,
        CancellationToken cancellationToken)
    {
        var http = Client();
        // A pin copies a whole film over someone else's uplink one chunk at a time. The timeout
        // has to cover a chunk, not the file.
        http.Timeout = TimeSpan.FromMinutes(10);
        var url = $"/stream/{Uri.EscapeDataString(group)}/{Uri.EscapeDataString(itemKey)}"
                  + $"/{Uri.EscapeDataString(node)}";
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(from, to);
        var response = await http
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
            .ConfigureAwait(false);
        if (response.IsSuccessStatusCode)
        {
            _lastOkUtc = DateTime.UtcNow;
        }

        return response;
    }

    /// <inheritdoc />
    public async Task<(byte[] Bytes, string? ContentType)?> ImageAsync(
        string group,
        string itemKey,
        string node,
        string kind,
        CancellationToken cancellationToken)
    {
        if (BaseUrl is null)
        {
            return null;
        }

        var url = $"/mesh/v1/image/{Uri.EscapeDataString(group)}/{Uri.EscapeDataString(itemKey)}"
                  + $"/{Uri.EscapeDataString(node)}/{Uri.EscapeDataString(kind)}";
        try
        {
            using var http = Client();
            http.Timeout = TimeSpan.FromSeconds(60);
            using var response = await http.GetAsync(url, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogDebug(
                    "Peer {Node} answered {Status} for the {Kind} image of {ItemKey}",
                    node,
                    (int)response.StatusCode,
                    kind,
                    itemKey);
                return null;
            }

            var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
            if (bytes.Length == 0)
            {
                return null;
            }

            _lastOkUtc = DateTime.UtcNow;
            return (bytes, response.Content.Headers.ContentType?.MediaType);
        }
        catch (Exception ex) when (IsTransport(ex))
        {
            _logger.LogDebug(ex, "Could not fetch the {Kind} image of {ItemKey} from {Node}", kind, itemKey, node);
            return null;
        }
    }

    /// <inheritdoc />
    public async Task<byte[]?> SubtitleAsync(
        string group,
        string itemKey,
        string node,
        int index,
        CancellationToken cancellationToken)
    {
        if (BaseUrl is null)
        {
            return null;
        }

        var url = string.Create(
            CultureInfo.InvariantCulture,
            $"{BaseUrl}/mesh/v1/subtitle/{Uri.EscapeDataString(group)}/{Uri.EscapeDataString(itemKey)}/{Uri.EscapeDataString(node)}/{index}");
        try
        {
            using var http = Client();
            using var response = await http.GetAsync(url, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogDebug(
                    "The mesh answered {Status} for subtitle {Index} of {ItemKey}",
                    (int)response.StatusCode,
                    index,
                    itemKey);
                return null;
            }

            _lastOkUtc = DateTime.UtcNow;
            return await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (IsTransport(ex))
        {
            _logger.LogDebug(ex, "Could not fetch subtitle {Index} of {ItemKey}", index, itemKey);
            return null;
        }
    }

    // --- plumbing ----------------------------------------------------------

    private async Task<T?> TryGetAsync<T>(string url, CancellationToken cancellationToken)
        where T : class
    {
        if (BaseUrl is null)
        {
            return null;
        }

        try
        {
            using var http = Client();
            using var response = await http.GetAsync(url, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogDebug("The mesh answered {Status} for {Url}", (int)response.StatusCode, url);
                return null;
            }

            _lastOkUtc = DateTime.UtcNow;
            return await response.Content
                .ReadFromJsonAsync<T>(MeshJson.Options, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (IsTransport(ex))
        {
            _logger.LogDebug(ex, "The mesh is not answering at {Url}", url);
            return null;
        }
    }

    private static async Task<T> ReadAsync<T>(HttpResponseMessage response, CancellationToken cancellationToken)
        where T : class
        => await response.Content.ReadFromJsonAsync<T>(MeshJson.Options, cancellationToken).ConfigureAwait(false)
           ?? throw new InvalidOperationException("The mesh returned an empty body.");

    /// <summary>
    /// Turn a non-2xx mesh answer into an exception carrying the mesh's own message.
    /// </summary>
    /// <remarks>
    /// The mesh answers errors as <c>{"error": "..."}</c> with the whole context chain in the
    /// string, precisely so the caller can show it. Throwing away that body and reporting
    /// "the mesh returned 400" is the difference between a user fixing an invite code and a user
    /// filing a bug.
    /// </remarks>
    private static async Task ThrowIfFailedAsync(
        HttpResponseMessage response,
        string what,
        CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        var message = body;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("error", out var error))
            {
                message = error.GetString() ?? body;
            }
        }
        catch (System.Text.Json.JsonException)
        {
            // Not JSON; the raw body is the best message available.
        }

        throw new MeshException($"{what} failed: the mesh answered {(int)response.StatusCode}: {message}");
    }

    /// <summary>Exceptions that mean "the mesh is not reachable", as opposed to a bug here.</summary>
    private static bool IsTransport(Exception ex)
        => ex is HttpRequestException or TaskCanceledException or OperationCanceledException
            or System.Net.Sockets.SocketException or System.Text.Json.JsonException
            or InvalidOperationException or UriFormatException;
}

/// <summary>The mesh refused an operation, carrying its own message.</summary>
public sealed class MeshException : Exception
{
    public MeshException()
    {
    }

    public MeshException(string message)
        : base(message)
    {
    }

    public MeshException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
