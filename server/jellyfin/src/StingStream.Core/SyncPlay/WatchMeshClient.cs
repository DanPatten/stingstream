using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Mesh;

namespace StingStream.Core.SyncPlay;

/// <summary>Talks to the mesh's watch-together routes (<c>/mesh/v1/watch/*</c>).</summary>
public interface IWatchMeshClient
{
    /// <summary>Every open session in a group.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The sessions, or null when the mesh could not be asked.</returns>
    Task<WatchSessionList?> ListAsync(string group, CancellationToken cancellationToken);

    /// <summary>One session, with where it is right now.</summary>
    /// <param name="sessionId">The session id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The session, or null.</returns>
    Task<WatchSessionView?> GetAsync(string sessionId, CancellationToken cancellationToken);

    /// <summary>Start a session with this node as leader.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="itemKey">The item key everybody will watch.</param>
    /// <param name="title">Display title.</param>
    /// <param name="viewers">How many local users are in the group.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The new session.</returns>
    Task<WatchSession> StartAsync(
        string group, string itemKey, string title, int viewers, CancellationToken cancellationToken);

    /// <summary>Join a session another node leads.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="sessionId">The session id.</param>
    /// <param name="viewers">How many local users are in the group.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The session as the leader holds it.</returns>
    Task<WatchSession> JoinAsync(
        string group, string sessionId, int viewers, CancellationToken cancellationToken);

    /// <summary>Leave, or end it if this node leads it.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="sessionId">The session id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    Task LeaveAsync(string group, string sessionId, CancellationToken cancellationToken);

    /// <summary>The leader tells every follower what to do.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="sessionId">The session id.</param>
    /// <param name="kind">Play, pause, seek or stop.</param>
    /// <param name="positionMs">Where the film should be.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The command as sent, including the instant it scheduled.</returns>
    Task<WatchCommand> CommandAsync(
        string group,
        string sessionId,
        WatchCommandKind kind,
        long positionMs,
        CancellationToken cancellationToken);

    /// <summary>Tell the leader where this node's own group has got to.</summary>
    /// <param name="group">The group id.</param>
    /// <param name="sessionId">The session id.</param>
    /// <param name="state">What this node's group is doing.</param>
    /// <param name="positionMs">Where it is.</param>
    /// <param name="viewers">How many local users are in it.</param>
    /// <param name="buffering">Whether it is buffering.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    Task ReportAsync(
        string group,
        string sessionId,
        WatchState state,
        long positionMs,
        int viewers,
        bool buffering,
        CancellationToken cancellationToken);
}

/// <inheritdoc />
/// <remarks>
/// A separate class rather than more methods on <see cref="MeshClient"/>, because the two have
/// different failure manners and it shows in the signatures. Inventory and index calls answer
/// <see langword="null"/> when the mesh is unreachable, because the materializer has to be able to
/// tell "no groups" from "no answer" and doing nothing is the safe response to the second. A watch
/// command is a user action with a person waiting on it, so it throws and the error reaches them.
/// </remarks>
public sealed class WatchMeshClient : IWatchMeshClient
{
    private readonly IMeshClient _mesh;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<WatchMeshClient> _logger;

    public WatchMeshClient(
        IMeshClient mesh,
        IHttpClientFactory httpFactory,
        ILogger<WatchMeshClient> logger)
    {
        _mesh = mesh;
        _httpFactory = httpFactory;
        _logger = logger;
    }

    private HttpClient Client() => _httpFactory.CreateClient(MeshClient.HttpClientName);

    private string Base => _mesh.BaseUrl
        ?? throw new InvalidOperationException("This node has no mesh, so there is nothing to watch together on.");

    /// <inheritdoc />
    public async Task<WatchSessionList?> ListAsync(string group, CancellationToken cancellationToken)
    {
        if (_mesh.BaseUrl is null)
        {
            return null;
        }

        try
        {
            using var http = Client();
            var url = $"{Base}/mesh/v1/watch?group={Uri.EscapeDataString(group)}";
            using var response = await http.GetAsync(url, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            return await response.Content
                .ReadFromJsonAsync<WatchSessionList>(MeshJson.Options, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            _logger.LogDebug(ex, "The mesh is not answering for watch sessions");
            return null;
        }
    }

    /// <inheritdoc />
    public async Task<WatchSessionView?> GetAsync(string sessionId, CancellationToken cancellationToken)
    {
        if (_mesh.BaseUrl is null)
        {
            return null;
        }

        try
        {
            using var http = Client();
            var url = $"{Base}/mesh/v1/watch/{Uri.EscapeDataString(sessionId)}";
            using var response = await http.GetAsync(url, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            return await response.Content
                .ReadFromJsonAsync<WatchSessionView>(MeshJson.Options, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            _logger.LogDebug(ex, "The mesh is not answering for watch session {Session}", sessionId);
            return null;
        }
    }

    /// <inheritdoc />
    public async Task<WatchSession> StartAsync(
        string group, string itemKey, string title, int viewers, CancellationToken cancellationToken)
        => await PostAsync<WatchSession>(
            $"{Base}/mesh/v1/watch",
            new { group, itemKey, title, viewers },
            "starting a watch session",
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<WatchSession> JoinAsync(
        string group, string sessionId, int viewers, CancellationToken cancellationToken)
        => await PostAsync<WatchSession>(
            $"{Base}/mesh/v1/watch/{Uri.EscapeDataString(sessionId)}/join",
            new { group, viewers },
            "joining a watch session",
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async Task LeaveAsync(string group, string sessionId, CancellationToken cancellationToken)
        => await PostVoidAsync(
            $"{Base}/mesh/v1/watch/{Uri.EscapeDataString(sessionId)}/leave",
            new { group, viewers = 0 },
            "leaving a watch session",
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<WatchCommand> CommandAsync(
        string group,
        string sessionId,
        WatchCommandKind kind,
        long positionMs,
        CancellationToken cancellationToken)
        => await PostAsync<WatchCommand>(
            $"{Base}/mesh/v1/watch/{Uri.EscapeDataString(sessionId)}/command",
            new { group, kind = Wire(kind), positionMs },
            "sending a watch command",
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async Task ReportAsync(
        string group,
        string sessionId,
        WatchState state,
        long positionMs,
        int viewers,
        bool buffering,
        CancellationToken cancellationToken)
        => await PostVoidAsync(
            $"{Base}/mesh/v1/watch/{Uri.EscapeDataString(sessionId)}/report",
            new { group, state = Wire(state), positionMs, viewers, buffering },
            "reporting a watch position",
            cancellationToken).ConfigureAwait(false);

    /// <summary>
    /// The mesh's own spelling of an enum.
    /// </summary>
    /// <remarks>
    /// The mesh is Rust with <c>#[serde(rename_all = "snake_case")]</c>, and Core's outbound
    /// serializer is Jellyfin's, which is PascalCase. Spelling these two by hand is three lines and
    /// removes the whole question of whose serializer settings apply to an anonymous type.
    /// </remarks>
    private static string Wire(WatchCommandKind kind) => kind switch
    {
        WatchCommandKind.Play => "play",
        WatchCommandKind.Pause => "pause",
        WatchCommandKind.Seek => "seek",
        WatchCommandKind.Stop => "stop",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, null),
    };

    private static string Wire(WatchState state) => state switch
    {
        WatchState.Idle => "idle",
        WatchState.Paused => "paused",
        WatchState.Playing => "playing",
        _ => throw new ArgumentOutOfRangeException(nameof(state), state, null),
    };

    private async Task<T> PostAsync<T>(
        string url, object body, string what, CancellationToken cancellationToken)
        where T : class
    {
        using var response = await SendAsync(url, body, what, cancellationToken).ConfigureAwait(false);
        return await response.Content
            .ReadFromJsonAsync<T>(MeshJson.Options, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException($"{what} returned an empty body.");
    }

    private async Task PostVoidAsync(
        string url, object body, string what, CancellationToken cancellationToken)
    {
        using var response = await SendAsync(url, body, what, cancellationToken).ConfigureAwait(false);
    }

    private async Task<HttpResponseMessage> SendAsync(
        string url, object body, string what, CancellationToken cancellationToken)
    {
        using var http = Client();
        var response = await http
            .PostAsJsonAsync(url, body, MeshJson.Options, cancellationToken)
            .ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            // The mesh answers `{"error": "..."}` with the whole context chain, precisely so a
            // caller can show it. Losing that and reporting "the mesh returned 400" is the
            // difference between a user fixing something and a user filing a bug.
            var status = (int)response.StatusCode;
            var raw = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            response.Dispose();
            throw new InvalidOperationException(string.Create(
                CultureInfo.InvariantCulture,
                $"{what} failed ({status}): {raw.Trim()}"));
        }

        return response;
    }
}
