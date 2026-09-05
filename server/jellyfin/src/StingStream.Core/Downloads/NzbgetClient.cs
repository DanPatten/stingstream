using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;

namespace StingStream.Core.Downloads;

/// <summary>
/// A thin client for NZBGet's native JSON-RPC control API.
/// </summary>
/// <remarks>
/// <para>
/// NZBGet has no REST surface; everything goes through <c>POST /jsonrpc</c> with HTTP Basic
/// credentials the supervisor generated and wrote into both <c>nzbget.conf</c> and
/// <c>runtime.json</c>. The supervisor's own health probe already speaks this protocol (see
/// <c>mesh/crates/stingstream/src/supervisor/mod.rs</c>, <c>nzbget_def</c>) — this is the same call
/// shape, from the other side.
/// </para>
/// <para>
/// Sizes come back as a <c>Lo</c>/<c>Hi</c> pair of 32-bit halves rather than one 64-bit number,
/// because the API predates JSON parsers that could be trusted with a large integer. Every size
/// this client returns has been reassembled by <see cref="Combine"/>; anything reading the raw
/// <c>MB</c> field instead would silently round a 3.7 GB download to the nearest megabyte.
/// </para>
/// </remarks>
public sealed class NzbgetClient
{
    /// <summary>Name of the <see cref="IHttpClientFactory"/> client used for NZBGet traffic.</summary>
    public const string HttpClientName = "StingStream.Nzbget";

    private readonly HttpClient _http;
    private readonly ILogger _logger;

    public NzbgetClient(ChildRuntime child, HttpClient http, ILogger logger)
    {
        _http = http;
        _logger = logger;
        BaseUrl = child.BaseUrl.TrimEnd('/');
        Username = child.Username ?? string.Empty;
        Password = child.Password ?? string.Empty;
    }

    public string BaseUrl { get; }

    public string Username { get; }

    public string Password { get; }

    /// <summary>Reassemble one of NZBGet's split 64-bit numbers.</summary>
    public static long Combine(JsonObject o, string prefix)
    {
        ArgumentNullException.ThrowIfNull(o);
        var lo = Number(o[prefix + "Lo"]) ?? 0;
        var hi = Number(o[prefix + "Hi"]) ?? 0;
        return (hi << 32) | (lo & 0xFFFFFFFFL);
    }

    /// <summary>
    /// Read a JSON number as a <see langword="long"/>, whatever it is really backed by.
    /// </summary>
    /// <remarks>
    /// <c>JsonNode.GetValue&lt;long&gt;()</c> only converts for a node that came out of
    /// <c>JsonNode.Parse</c>; one built in code from an <c>int</c> throws
    /// <see cref="InvalidOperationException"/> instead, because a CLR-backed <see cref="JsonValue"/>
    /// holds its original type and will not widen. Every value this client reads comes from a real
    /// parse today, so the strict form worked — but it made the shaping impossible to unit-test
    /// against a hand-built object, and a caller that ever builds one would have found out at
    /// runtime. NZBGet also reports some counters as strings.
    /// </remarks>
    public static long? Number(JsonNode? node)
    {
        if (node is not JsonValue value)
        {
            return null;
        }

        if (value.TryGetValue<long>(out var l))
        {
            return l;
        }

        if (value.TryGetValue<int>(out var i))
        {
            return i;
        }

        if (value.TryGetValue<double>(out var d))
        {
            return (long)d;
        }

        if (value.TryGetValue<string>(out var s)
            && long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
        {
            return parsed;
        }

        return null;
    }

    private async Task<JsonNode?> CallAsync(string method, JsonArray parameters, CancellationToken ct)
    {
        var body = new JsonObject
        {
            ["version"] = "1.1",
            ["id"] = 1,
            ["method"] = method,
            ["params"] = parameters,
        };

        using var req = new HttpRequestMessage(HttpMethod.Post, $"{BaseUrl}/jsonrpc")
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        var credentials = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{Username}:{Password}"));
        req.Headers.Authorization = new AuthenticationHeaderValue("Basic", credentials);

        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            throw new NzbgetException($"NZBGet {method} failed: {(int)res.StatusCode} {res.ReasonPhrase}");
        }

        JsonNode? parsed;
        try
        {
            parsed = JsonNode.Parse(text);
        }
        catch (System.Text.Json.JsonException ex)
        {
            throw new NzbgetException($"NZBGet {method} returned unparseable JSON", ex);
        }

        if (parsed is JsonObject envelope)
        {
            // JSON-RPC puts a failure in `error`, with a 200 status. Ignoring it would turn "your
            // password is wrong" into "you have no downloads".
            if (envelope["error"] is JsonObject error)
            {
                var message = error["message"]?.GetValue<string>() ?? "unknown error";
                throw new NzbgetException($"NZBGet {method} failed: {message}");
            }

            return envelope["result"];
        }

        return parsed;
    }

    /// <summary>NZBGet's version string, or null when it is not answering.</summary>
    public async Task<string?> VersionAsync(CancellationToken ct = default)
    {
        try
        {
            var result = await CallAsync("version", new JsonArray(), ct).ConfigureAwait(false);
            return result?.GetValue<string>();
        }
        catch (Exception ex) when (ex is NzbgetException or HttpRequestException or TaskCanceledException)
        {
            _logger.LogDebug(ex, "NZBGet did not report a version");
            return null;
        }
    }

    /// <summary>Every NZB in the queue and post-processing.</summary>
    public async Task<List<JsonObject>> ListGroupsAsync(CancellationToken ct = default)
    {
        var result = await CallAsync("listgroups", new JsonArray { 0 }, ct).ConfigureAwait(false);
        return result is JsonArray arr ? arr.OfType<JsonObject>().ToList() : new List<JsonObject>();
    }

    /// <summary>NZBGet's own status document: rates, paused flag, free space.</summary>
    public async Task<JsonObject?> StatusAsync(CancellationToken ct = default)
        => await CallAsync("status", new JsonArray(), ct).ConfigureAwait(false) as JsonObject;

    /// <summary>
    /// Run one <c>editqueue</c> command against a group.
    /// </summary>
    /// <remarks>
    /// The three-argument form (<c>Command</c>, <c>Param</c>, <c>IDs</c>). NZBGet carried a
    /// four-argument form with an <c>Offset</c> in the middle until v15; the vendored build is 26.x
    /// and only has this one, so the older shape is not attempted — a node running something that
    /// old would fail loudly here rather than silently editing the wrong entry, which is the right
    /// way round.
    /// </remarks>
    public async Task<bool> EditQueueAsync(
        string command,
        string parameter,
        IEnumerable<int> ids,
        CancellationToken ct = default)
    {
        var idArray = new JsonArray();
        foreach (var id in ids)
        {
            idArray.Add(id);
        }

        var result = await CallAsync("editqueue", new JsonArray { command, parameter, idArray }, ct)
            .ConfigureAwait(false);
        return result?.GetValue<bool>() ?? false;
    }

    /// <summary>Pause one NZB.</summary>
    public Task<bool> PauseAsync(int nzbId, CancellationToken ct = default)
        => EditQueueAsync("GroupPause", string.Empty, new[] { nzbId }, ct);

    /// <summary>Resume one NZB.</summary>
    public Task<bool> ResumeAsync(int nzbId, CancellationToken ct = default)
        => EditQueueAsync("GroupResume", string.Empty, new[] { nzbId }, ct);

    /// <summary>
    /// Delete one NZB, taking any already-downloaded files with it.
    /// </summary>
    /// <remarks>
    /// <c>GroupFinalDelete</c> rather than <c>GroupDelete</c>: the plain form moves the entry into
    /// the history as "deleted", where it stays visible and blocks the same NZB being re-added,
    /// which is not what "remove this download" means to somebody looking at a Downloads screen.
    /// </remarks>
    public Task<bool> DeleteAsync(int nzbId, CancellationToken ct = default)
        => EditQueueAsync("GroupFinalDelete", string.Empty, new[] { nzbId }, ct);

    /// <summary>Format an id the way NZBGet's JSON expects.</summary>
    internal static string Invariant(int value) => value.ToString(CultureInfo.InvariantCulture);
}

/// <summary>Raised when NZBGet's control API answers with something other than a result.</summary>
public sealed class NzbgetException : Exception
{
    public NzbgetException()
    {
    }

    public NzbgetException(string message)
        : base(message)
    {
    }

    public NzbgetException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>Builds an <see cref="NzbgetClient"/> from <c>runtime.json</c>, or nothing.</summary>
public sealed class NzbgetClientFactory
{
    private readonly INodeRuntimeProvider _runtime;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILoggerFactory _loggerFactory;

    public NzbgetClientFactory(
        INodeRuntimeProvider runtime,
        IHttpClientFactory httpFactory,
        ILoggerFactory loggerFactory)
    {
        _runtime = runtime;
        _httpFactory = httpFactory;
        _loggerFactory = loggerFactory;
    }

    /// <summary>A client, or <see langword="null"/> when NZBGet is disabled or not configured.</summary>
    public NzbgetClient? Create()
    {
        var child = _runtime.Current?.EnabledChild("nzbget");
        if (child is null || string.IsNullOrWhiteSpace(child.BaseUrl))
        {
            return null;
        }

        return new NzbgetClient(
            child,
            _httpFactory.CreateClient(NzbgetClient.HttpClientName),
            _loggerFactory.CreateLogger("StingStream.Core.Downloads.Nzbget"));
    }
}
