using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;

namespace StingStream.Core.Arr;

/// <summary>Which of the two NzbDrone descendants a client is talking to.</summary>
public enum ArrKind
{
    /// <summary>Radarr: movies.</summary>
    Radarr,

    /// <summary>Sonarr: series.</summary>
    Sonarr,
}

/// <summary>
/// Raised when an arr's API answers with something other than success.
/// </summary>
public sealed class ArrApiException : Exception
{
    public ArrApiException(string message, HttpStatusCode? status = null, string? body = null)
        : base(message)
    {
        Status = status;
        Body = body;
    }

    public ArrApiException()
    {
    }

    public ArrApiException(string message)
        : base(message)
    {
    }

    public ArrApiException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    public HttpStatusCode? Status { get; }

    /// <summary>The response body, which is where NzbDrone puts its validation failures.</summary>
    public string? Body { get; }
}

/// <summary>
/// A thin client for Radarr's and Sonarr's v3 REST API.
/// </summary>
/// <remarks>
/// Deliberately untyped in the middle: provider resources (indexers, download clients,
/// notifications) carry a <c>fields</c> array whose contents differ per implementation and per
/// app version, and the reliable way to build one is to ask the app for its own
/// <c>/schema</c> and fill in the values. Modelling those as C# classes would mean re-deriving
/// upstream's settings classes and re-deriving them again on the next subtree pull, so this works
/// in <see cref="JsonNode"/> and lets <see cref="OmniarrSyncService"/> hold the mapping.
/// </remarks>
public sealed class ArrClient
{
    /// <summary>Name of the <see cref="IHttpClientFactory"/> client used for arr traffic.</summary>
    public const string HttpClientName = "StingStream.Arr";

    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private readonly HttpClient _http;
    private readonly ILogger _logger;

    public ArrClient(ArrKind kind, ChildRuntime child, HttpClient http, ILogger logger)
    {
        Kind = kind;
        Child = child;
        _http = http;
        _logger = logger;

        BaseUrl = child.BaseUrl.TrimEnd('/');
        ApiKey = child.ApiKey ?? string.Empty;
    }

    public ArrKind Kind { get; }

    public ChildRuntime Child { get; }

    /// <summary>Base URL including the app's UrlBase, e.g. <c>http://127.0.0.1:7878/radarr</c>.</summary>
    public string BaseUrl { get; }

    public string ApiKey { get; }

    public string Name => Kind == ArrKind.Radarr ? "radarr" : "sonarr";

    /// <summary>Radarr's library resource is <c>movie</c>; Sonarr's is <c>series</c>.</summary>
    public string LibraryResource => Kind == ArrKind.Radarr ? "movie" : "series";

    // --- primitives --------------------------------------------------------

    private HttpRequestMessage Request(HttpMethod method, string path)
    {
        var url = path.StartsWith("http", StringComparison.OrdinalIgnoreCase)
            ? path
            : $"{BaseUrl}/api/v3/{path.TrimStart('/')}";
        var req = new HttpRequestMessage(method, url);
        // Both apps register an "API" authentication scheme keyed on this header, which works
        // regardless of the AuthenticationMethod in config.xml.
        req.Headers.TryAddWithoutValidation("X-Api-Key", ApiKey);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return req;
    }

    private async Task<JsonNode?> SendAsync(
        HttpMethod method,
        string path,
        JsonNode? body,
        CancellationToken cancellationToken)
    {
        using var req = Request(method, path);
        if (body is not null)
        {
            req.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        }

        using var res = await _http.SendAsync(req, cancellationToken).ConfigureAwait(false);
        var text = await res.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

        if (!res.IsSuccessStatusCode)
        {
            throw new ArrApiException(
                $"{Name} {method} {path} failed: {(int)res.StatusCode} {res.ReasonPhrase}. {Truncate(text)}",
                res.StatusCode,
                text);
        }

        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(text);
        }
        catch (JsonException ex)
        {
            throw new ArrApiException($"{Name} {method} {path} returned unparseable JSON: {Truncate(text)}", ex);
        }
    }

    private static string Truncate(string s)
        => s.Length <= 600 ? s : string.Concat(s.AsSpan(0, 600), "...");

    public Task<JsonNode?> GetAsync(string path, CancellationToken ct = default)
        => SendAsync(HttpMethod.Get, path, null, ct);

    public Task<JsonNode?> PostAsync(string path, JsonNode body, CancellationToken ct = default)
        => SendAsync(HttpMethod.Post, path, body, ct);

    public Task<JsonNode?> PutAsync(string path, JsonNode body, CancellationToken ct = default)
        => SendAsync(HttpMethod.Put, path, body, ct);

    public Task<JsonNode?> DeleteAsync(string path, CancellationToken ct = default)
        => SendAsync(HttpMethod.Delete, path, null, ct);

    /// <summary>Every element of an array resource.</summary>
    public async Task<List<JsonObject>> ListAsync(string path, CancellationToken ct = default)
    {
        var node = await GetAsync(path, ct).ConfigureAwait(false);
        return node is JsonArray arr
            ? arr.OfType<JsonObject>().ToList()
            : new List<JsonObject>();
    }

    // --- health ------------------------------------------------------------

    /// <summary>Reports whether the app is up and accepts our API key.</summary>
    public async Task<bool> IsReachableAsync(CancellationToken ct = default)
    {
        try
        {
            var status = await GetAsync("system/status", ct).ConfigureAwait(false);
            return status is JsonObject;
        }
        catch (Exception ex) when (ex is ArrApiException or HttpRequestException or TaskCanceledException)
        {
            _logger.LogDebug(ex, "{App} is not reachable yet at {Url}", Name, BaseUrl);
            return false;
        }
    }

    /// <summary>Wait until the app answers, or the timeout elapses.</summary>
    public async Task<bool> WaitUntilReachableAsync(TimeSpan timeout, CancellationToken ct = default)
    {
        var deadline = DateTime.UtcNow + timeout;
        var delay = TimeSpan.FromSeconds(1);
        while (DateTime.UtcNow < deadline && !ct.IsCancellationRequested)
        {
            if (await IsReachableAsync(ct).ConfigureAwait(false))
            {
                return true;
            }

            await Task.Delay(delay, ct).ConfigureAwait(false);
            // A cold Radarr can take a minute to migrate its database; backing off keeps that from
            // being sixty log lines.
            delay = TimeSpan.FromSeconds(Math.Min(delay.TotalSeconds * 1.5, 10));
        }

        return false;
    }

    // --- provider resources (indexer / downloadclient / notification) -------

    /// <summary>
    /// Fetch the app's own schema for a provider resource and pick the entry for one
    /// implementation.
    /// </summary>
    /// <remarks>
    /// This is what makes the sync robust across upstream churn: the returned object already has
    /// the exact <c>fields</c> array, with the right names, types and defaults for the version of
    /// the app that is actually running. The caller fills in values and posts it back.
    /// </remarks>
    public async Task<JsonObject?> GetSchemaAsync(string resource, string implementation, CancellationToken ct = default)
    {
        var schemas = await ListAsync($"{resource}/schema", ct).ConfigureAwait(false);
        return schemas.FirstOrDefault(s =>
            string.Equals(s["implementation"]?.GetValue<string>(), implementation, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Find an existing provider by name.</summary>
    public async Task<JsonObject?> FindByNameAsync(string resource, string name, CancellationToken ct = default)
    {
        var all = await ListAsync(resource, ct).ConfigureAwait(false);
        return all.FirstOrDefault(x =>
            string.Equals(x["name"]?.GetValue<string>(), name, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Create or update a provider resource, matching an existing one by name.
    /// </summary>
    /// <returns>The resource as the app stored it.</returns>
    public async Task<JsonObject> UpsertProviderAsync(
        string resource,
        JsonObject desired,
        CancellationToken ct = default)
    {
        var name = desired["name"]?.GetValue<string>()
            ?? throw new ArgumentException("A provider resource must have a name.", nameof(desired));

        var existing = await FindByNameAsync(resource, name, ct).ConfigureAwait(false);
        if (existing is null)
        {
            var created = await PostAsync(resource, desired, ct).ConfigureAwait(false);
            return created as JsonObject ?? desired;
        }

        var id = existing["id"]?.GetValue<int>() ?? 0;
        var merged = desired.DeepClone().AsObject();
        merged["id"] = id;
        // forceSave skips the app's own connectivity test on save. Without it, saving a download
        // client whose target is still starting fails validation and the whole first run aborts;
        // the sync reports reachability separately.
        var updated = await PutAsync($"{resource}/{id}?forceSave=true", merged, ct).ConfigureAwait(false);
        return updated as JsonObject ?? merged;
    }

    /// <summary>Set the value of a named field inside a provider resource's <c>fields</c> array.</summary>
    /// <returns><see langword="true"/> when the field existed and was set.</returns>
    public static bool SetField(JsonObject provider, string fieldName, JsonNode? value)
    {
        if (provider["fields"] is not JsonArray fields)
        {
            return false;
        }

        foreach (var entry in fields.OfType<JsonObject>())
        {
            // NzbDrone matches field names ordinally and case-sensitively when binding a posted
            // resource back onto its settings class, so this comparison is ordinal too.
            if (string.Equals(entry["name"]?.GetValue<string>(), fieldName, StringComparison.Ordinal))
            {
                entry["value"] = value;
                return true;
            }
        }

        return false;
    }

    /// <summary>Read a named field's value from a provider resource.</summary>
    public static JsonNode? GetField(JsonObject provider, string fieldName)
    {
        if (provider["fields"] is not JsonArray fields)
        {
            return null;
        }

        return fields.OfType<JsonObject>()
            .FirstOrDefault(e => string.Equals(e["name"]?.GetValue<string>(), fieldName, StringComparison.Ordinal))
            ?["value"];
    }

    // --- root folders ------------------------------------------------------

    /// <summary>Add a root folder if the app does not already have it. Idempotent.</summary>
    public async Task<bool> EnsureRootFolderAsync(string path, CancellationToken ct = default)
    {
        var existing = await ListAsync("rootfolder", ct).ConfigureAwait(false);
        var already = existing.Any(f => PathsEqual(f["path"]?.GetValue<string>(), path));
        if (already)
        {
            return false;
        }

        await PostAsync("rootfolder", new JsonObject { ["path"] = path }, ct).ConfigureAwait(false);
        return true;
    }

    private static bool PathsEqual(string? a, string? b)
    {
        if (a is null || b is null)
        {
            return false;
        }

        // The apps normalize and may append a separator; compare with both trimmed. Case-insensitive
        // because Windows paths are, and a case-only difference is never two different folders on
        // the platforms StingStream targets for a full node.
        static string Norm(string s) => s.TrimEnd('/', '\\').Replace('\\', '/');
        return string.Equals(Norm(a), Norm(b), StringComparison.OrdinalIgnoreCase);
    }

    // --- quality profiles --------------------------------------------------

    /// <summary>
    /// The id of a quality profile by name, or of the first profile when the name is empty or
    /// unknown. A fresh Radarr or Sonarr always has at least one.
    /// </summary>
    public async Task<int?> ResolveQualityProfileAsync(string? preferredName, CancellationToken ct = default)
    {
        var profiles = await ListAsync("qualityprofile", ct).ConfigureAwait(false);
        if (profiles.Count == 0)
        {
            return null;
        }

        if (!string.IsNullOrWhiteSpace(preferredName))
        {
            var match = profiles.FirstOrDefault(p =>
                string.Equals(p["name"]?.GetValue<string>(), preferredName, StringComparison.OrdinalIgnoreCase));
            if (match?["id"] is { } id)
            {
                return id.GetValue<int>();
            }

            _logger.LogWarning(
                "{App} has no quality profile named {Name}; using {Fallback}",
                Name,
                preferredName,
                profiles[0]["name"]?.GetValue<string>());
        }

        return profiles[0]["id"]?.GetValue<int>();
    }

    // --- library -----------------------------------------------------------

    /// <summary>Look up an existing movie by TMDB id.</summary>
    public async Task<JsonObject?> FindMovieByTmdbAsync(int tmdbId, CancellationToken ct = default)
    {
        var all = await ListAsync("movie", ct).ConfigureAwait(false);
        return all.FirstOrDefault(m => m["tmdbId"]?.GetValue<int>() == tmdbId);
    }

    /// <summary>Look up an existing series by TVDB id.</summary>
    public async Task<JsonObject?> FindSeriesByTvdbAsync(int tvdbId, CancellationToken ct = default)
    {
        var all = await ListAsync("series", ct).ConfigureAwait(false);
        return all.FirstOrDefault(s => s["tvdbId"]?.GetValue<int>() == tvdbId);
    }

    /// <summary>
    /// Ask the app's metadata lookup for a title, so an add carries the fields the app requires
    /// (<c>title</c>, <c>year</c>, <c>titleSlug</c>, <c>images</c>) without StingStream having to
    /// know a metadata provider itself.
    /// </summary>
    public async Task<JsonObject?> LookupAsync(string term, CancellationToken ct = default)
    {
        var path = Kind == ArrKind.Radarr
            ? $"movie/lookup?term={Uri.EscapeDataString(term)}"
            : $"series/lookup?term={Uri.EscapeDataString(term)}";
        var node = await GetAsync(path, ct).ConfigureAwait(false);
        return node is JsonArray arr ? arr.OfType<JsonObject>().FirstOrDefault() : node as JsonObject;
    }

    /// <summary>Trigger one of the app's named commands, e.g. <c>MoviesSearch</c> or <c>RefreshSeries</c>.</summary>
    public Task<JsonNode?> CommandAsync(JsonObject command, CancellationToken ct = default)
        => PostAsync("command", command, ct);

    /// <summary>The app's queue, used to watch a grab progress.</summary>
    public async Task<List<JsonObject>> QueueAsync(CancellationToken ct = default)
    {
        var node = await GetAsync("queue?pageSize=200&includeUnknownMovieItems=true&includeUnknownSeriesItems=true", ct)
            .ConfigureAwait(false);
        if (node is JsonObject page && page["records"] is JsonArray records)
        {
            return records.OfType<JsonObject>().ToList();
        }

        return node is JsonArray arr ? arr.OfType<JsonObject>().ToList() : new List<JsonObject>();
    }

    /// <summary>Format a number the way NzbDrone's JSON expects, with no locale surprises.</summary>
    internal static string Invariant(int value) => value.ToString(CultureInfo.InvariantCulture);
}
