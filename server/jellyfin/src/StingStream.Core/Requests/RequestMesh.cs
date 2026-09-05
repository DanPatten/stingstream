using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Mesh;

namespace StingStream.Core.Requests;

/// <summary>One node's claim on a request, as the mesh reports it.</summary>
public sealed class MeshClaim
{
    public string RequestId { get; set; } = string.Empty;

    /// <summary>The claiming node's iroh id.</summary>
    public string Node { get; set; } = string.Empty;

    public string NodeName { get; set; } = string.Empty;

    /// <summary>Milliseconds since the epoch, frozen at the first claim.</summary>
    public long ClaimedAt { get; set; }

    /// <summary>
    /// <c>claimed</c>, <c>fulfilling</c>, <c>available</c>, <c>failed</c> or <c>released</c>.
    /// </summary>
    public string State { get; set; } = string.Empty;

    public string Note { get; set; } = string.Empty;

    public string UpdatedAt { get; set; } = string.Empty;
}

/// <summary>The claim states, mirrored from the mesh crate's <c>ClaimStates</c>.</summary>
public static class ClaimStates
{
    public const string Claimed = "claimed";

    public const string Fulfilling = "fulfilling";

    public const string Available = "available";

    public const string Failed = "failed";

    public const string Released = "released";
}

/// <summary>A request as it travels the group, with every claim on it and the winner.</summary>
public sealed class MeshRequestView
{
    public string RequestId { get; set; } = string.Empty;

    /// <summary>The node that published it.</summary>
    public string Origin { get; set; } = string.Empty;

    /// <summary><c>movie</c> or <c>series</c>.</summary>
    public string Kind { get; set; } = string.Empty;

    public string ItemKey { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;

    public string Provider { get; set; } = string.Empty;

    public string ProviderId { get; set; } = string.Empty;

    public List<int> Seasons { get; set; } = new();

    public string RequestedBy { get; set; } = string.Empty;

    public string RequestedAt { get; set; } = string.Empty;

    public List<MeshClaim> Claims { get; set; } = new();

    /// <summary>The node that must fulfil it, or null while nobody has claimed.</summary>
    public string? Winner { get; set; }

    /// <summary>The winning claim, when there is one.</summary>
    public MeshClaim? WinningClaim()
    {
        if (Winner is null)
        {
            return null;
        }

        foreach (var claim in Claims)
        {
            if (string.Equals(claim.Node, Winner, StringComparison.OrdinalIgnoreCase))
            {
                return claim;
            }
        }

        return null;
    }
}

/// <summary>Talks to this node's mesh about requests and claims.</summary>
public interface IRequestMesh
{
    /// <summary>Publish a request into a group, so every member learns about it.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="row">The request.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The group's view of it, or null when the mesh could not be asked.</returns>
    Task<MeshRequestView?> PublishAsync(string group, RequestRow row, CancellationToken cancellationToken);

    /// <summary>Claim a request for this node, or update the claim already made.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="requestId">The request id.</param>
    /// <param name="state">One of <see cref="ClaimStates"/>.</param>
    /// <param name="note">Why, for a failure.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The view including the winner, or null when the mesh could not be asked.</returns>
    Task<MeshRequestView?> ClaimAsync(
        string group,
        string requestId,
        string state,
        string note,
        CancellationToken cancellationToken);

    /// <summary>Every request this node knows about in a group.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The views, or null when the mesh could not be asked.</returns>
    Task<IReadOnlyList<MeshRequestView>?> ListAsync(string group, CancellationToken cancellationToken);

    /// <summary>One request.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="requestId">The request id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The view, or null.</returns>
    Task<MeshRequestView?> GetAsync(string group, string requestId, CancellationToken cancellationToken);

    /// <summary>Tell the mesh what this node could grab, so the group can volunteer it.</summary>
    /// <param name="canFulfilMovies">Whether Radarr, a movie indexer, a root folder and room are all present.</param>
    /// <param name="canFulfilTv">The same for Sonarr.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when the mesh accepted it.</returns>
    Task<bool> PublishFulfilmentAsync(
        bool canFulfilMovies,
        bool canFulfilTv,
        CancellationToken cancellationToken);

    /// <summary>
    /// Every other member's advertised ability to fulfil a request, from their last heartbeat.
    /// </summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The capabilities, or null when the mesh could not be asked.</returns>
    /// <remarks>
    /// Read straight off <c>/mesh/v1/peers</c> rather than through <c>IMeshClient.PeersAsync</c>:
    /// the router wants three fields, and taking them here keeps M6 out of a model class two other
    /// work packages are editing. The cost is one duplicated DTO; the alternative was a merge
    /// conflict in somebody else's commit.
    /// </remarks>
    Task<IReadOnlyList<FulfilCapability>?> CapabilitiesAsync(string group, CancellationToken cancellationToken);
}

/// <inheritdoc />
/// <remarks>
/// <para>
/// A separate client rather than four more methods on <see cref="IMeshClient"/>. That is not an
/// architectural preference — it is the shared checkout: <c>Mesh/MeshClient.cs</c> is a file two
/// other work packages are editing, and adding to it would put M6's half of a request in the same
/// commit as somebody else's half of something entirely different. What is shared is the thing that
/// matters, <see cref="IMeshClient.BaseUrl"/>, so there is exactly one answer on this node to "where
/// is the mesh".
/// </para>
/// <para>
/// Every read answers "the mesh is not there" with <see langword="null"/> rather than an exception,
/// for the same reason <see cref="MeshClient"/> does: a node whose mesh is restarting is still a
/// working server, and the fulfilment loop's next pass is seconds away. Null is emphatically not
/// "no requests" — a caller that confused the two would conclude nobody had claimed and start a
/// second download.
/// </para>
/// </remarks>
public sealed class RequestMesh : IRequestMesh
{
    private readonly IMeshClient _mesh;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<RequestMesh> _logger;

    public RequestMesh(IMeshClient mesh, IHttpClientFactory httpFactory, ILogger<RequestMesh> logger)
    {
        _mesh = mesh;
        _httpFactory = httpFactory;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task<MeshRequestView?> PublishAsync(string group, RequestRow row, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);
        return PostAsync(
            "/mesh/v1/requests",
            new
            {
                group,
                request_id = row.Id,
                kind = row.Kind,
                item_key = row.ItemKey,
                title = row.Describe(),
                provider = row.Provider,
                provider_id = row.ProviderId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                seasons = row.Seasons,
                requested_by = row.RequestedByName,
                requested_at = row.RequestedAt,
            },
            cancellationToken);
    }

    /// <inheritdoc />
    public Task<MeshRequestView?> ClaimAsync(
        string group,
        string requestId,
        string state,
        string note,
        CancellationToken cancellationToken)
        => PostAsync(
            "/mesh/v1/requests/claim",
            new
            {
                group,
                request_id = requestId,
                state,
                note = note ?? string.Empty,
            },
            cancellationToken);

    /// <inheritdoc />
    public async Task<IReadOnlyList<MeshRequestView>?> ListAsync(
        string group,
        CancellationToken cancellationToken)
    {
        var body = await GetAsync<RequestsBody>(
            $"/mesh/v1/requests?group={Uri.EscapeDataString(group)}",
            cancellationToken).ConfigureAwait(false);
        return body?.Requests;
    }

    /// <inheritdoc />
    public Task<MeshRequestView?> GetAsync(string group, string requestId, CancellationToken cancellationToken)
        => GetAsync<MeshRequestView>(
            $"/mesh/v1/requests/{Uri.EscapeDataString(requestId)}?group={Uri.EscapeDataString(group)}",
            cancellationToken);

    /// <inheritdoc />
    public async Task<bool> PublishFulfilmentAsync(
        bool canFulfilMovies,
        bool canFulfilTv,
        CancellationToken cancellationToken)
    {
        var http = Client();
        if (http is null)
        {
            return false;
        }

        try
        {
            using var response = await http
                .PutAsJsonAsync(
                    "/mesh/v1/fulfilment",
                    new { can_fulfil_movies = canFulfilMovies, can_fulfil_tv = canFulfilTv },
                    MeshJson.Options,
                    cancellationToken)
                .ConfigureAwait(false);
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex) when (IsTransport(ex))
        {
            _logger.LogDebug(ex, "Could not publish this node's fulfilment capability");
            return false;
        }
    }

    /// <inheritdoc />
    public async Task<IReadOnlyList<FulfilCapability>?> CapabilitiesAsync(
        string group,
        CancellationToken cancellationToken)
    {
        var rows = await GetAsync<List<PeerCapability>>(
            $"/mesh/v1/peers?group={Uri.EscapeDataString(group)}",
            cancellationToken).ConfigureAwait(false);
        if (rows is null)
        {
            return null;
        }

        var list = new List<FulfilCapability>(rows.Count);
        foreach (var row in rows)
        {
            list.Add(new FulfilCapability
            {
                Node = row.Node,
                NodeName = string.IsNullOrWhiteSpace(row.NodeName) ? row.Node : row.NodeName,
                Online = row.Online,
                CanFulfilMovies = row.CanFulfilMovies,
                CanFulfilTv = row.CanFulfilTv,
                FreeSpace = row.FreeSpace ?? 0,
            });
        }

        return list;
    }

    private sealed class RequestsBody
    {
        public string Group { get; set; } = string.Empty;

        public List<MeshRequestView> Requests { get; set; } = new();
    }

    /// <summary>The three fields of a peer row the request router weighs, and nothing else.</summary>
    private sealed class PeerCapability
    {
        public string Node { get; set; } = string.Empty;

        public string NodeName { get; set; } = string.Empty;

        public bool Online { get; set; }

        public bool CanFulfilMovies { get; set; }

        public bool CanFulfilTv { get; set; }

        public long? FreeSpace { get; set; }
    }

    private HttpClient? Client()
    {
        var baseUrl = _mesh.BaseUrl;
        if (baseUrl is null)
        {
            return null;
        }

        var http = _httpFactory.CreateClient(MeshClient.HttpClientName);
        http.BaseAddress = new Uri(baseUrl, UriKind.Absolute);
        http.Timeout = TimeSpan.FromSeconds(20);
        return http;
    }

    private async Task<T?> GetAsync<T>(string url, CancellationToken cancellationToken)
        where T : class
    {
        var http = Client();
        if (http is null)
        {
            return null;
        }

        try
        {
            using var response = await http.GetAsync(url, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                // A 404 for one request is ordinary: gossip has no ordering guarantee and the node
                // may simply not have heard yet.
                _logger.LogDebug("The mesh answered {Status} for {Url}", (int)response.StatusCode, url);
                return null;
            }

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

    private async Task<MeshRequestView?> PostAsync(string url, object body, CancellationToken cancellationToken)
    {
        var http = Client();
        if (http is null)
        {
            return null;
        }

        try
        {
            using var response = await http
                .PostAsJsonAsync(url, body, MeshJson.Options, cancellationToken)
                .ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                var detail = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                _logger.LogWarning(
                    "The mesh refused {Url}: {Status} {Detail}",
                    url,
                    (int)response.StatusCode,
                    detail);
                return null;
            }

            return await response.Content
                .ReadFromJsonAsync<MeshRequestView>(MeshJson.Options, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (IsTransport(ex))
        {
            _logger.LogDebug(ex, "The mesh is not answering at {Url}", url);
            return null;
        }
    }

    private static bool IsTransport(Exception ex)
        => ex is HttpRequestException or TaskCanceledException or OperationCanceledException
            or System.Net.Sockets.SocketException or System.Text.Json.JsonException
            or InvalidOperationException or UriFormatException;
}
