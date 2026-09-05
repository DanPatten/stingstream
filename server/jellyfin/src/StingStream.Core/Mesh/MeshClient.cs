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
    /// <param name="coordinator">Optional coordinator URL; null or empty means zero-server.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The new group.</returns>
    Task<MeshGroup> CreateGroupAsync(string name, string? coordinator, CancellationToken cancellationToken);

    /// <summary>Join a group from an invite code.</summary>
    /// <param name="code">The invite code.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>What the join reached.</returns>
    Task<MeshJoinResult> JoinGroupAsync(string code, CancellationToken cancellationToken);

    /// <summary>Mint an invite code for a group.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The invite code.</returns>
    Task<string> InviteAsync(string group, CancellationToken cancellationToken);

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
    public async Task<MeshGroup> CreateGroupAsync(string name, string? coordinator, CancellationToken cancellationToken)
    {
        using var http = Client();
        using var response = await http.PostAsJsonAsync(
                "/mesh/v1/groups",
                new { name, coordinator },
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
    public async Task<string> InviteAsync(string group, CancellationToken cancellationToken)
    {
        using var http = Client();
        using var response = await http.PostAsync(
                $"/mesh/v1/groups/{Uri.EscapeDataString(group)}/invite",
                content: null,
                cancellationToken)
            .ConfigureAwait(false);
        await ThrowIfFailedAsync(response, "minting an invite", cancellationToken).ConfigureAwait(false);
        var invite = await ReadAsync<MeshInvite>(response, cancellationToken).ConfigureAwait(false);
        return invite.Code;
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
