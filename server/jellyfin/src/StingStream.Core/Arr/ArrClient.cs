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

    /// <summary>What to call one of these apps in a sentence that reaches a person.</summary>
    /// <param name="kind">Which app.</param>
    /// <returns>A mid-sentence name for it.</returns>
    /// <remarks>
    /// Somebody using StingStream never chose Radarr or Sonarr and should not have to learn which
    /// of them owns films in order to read a sync result or an error. <see cref="Name"/> stays the
    /// real name, because that is an identifier -- the <c>App</c> key on a sync status, a
    /// dictionary key, a log field -- and renaming it would break every caller that matches on it.
    /// This is the other half: the half people read. Lower case, because it almost always appears
    /// mid-sentence; the one caller that needs it first capitalises it there.
    /// </remarks>
    public static string DisplayName(ArrKind kind)
        => kind == ArrKind.Radarr ? "the movie manager" : "the series manager";

    /// <summary>What to call this app in a sentence that reaches a person.</summary>
    public string Display => DisplayName(Kind);

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

    /// <summary>
    /// Collapse a response body onto one line and cap it.
    /// </summary>
    /// <remarks>
    /// NzbDrone pretty-prints its validation failures, and the supervisor's log is JSON lines --
    /// one line per line of child output -- so a multi-line message loses everything after the
    /// first newline exactly when the detail matters most.
    /// </remarks>
    private static string Truncate(string s)
    {
        var oneLine = System.Text.RegularExpressions.Regex.Replace(s, @"\s+", " ").Trim();
        return oneLine.Length <= 600 ? oneLine : string.Concat(oneLine.AsSpan(0, 600), "...");
    }

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

        // forceSave on both paths skips the app's own connectivity test. Without it, creating a
        // download client whose target is not answering *at that instant* fails with
        // "Host: Unable to connect to qBittorrent" and takes the whole first-run wiring with it --
        // and the target here is the qBittorrent shim inside this very process, which on a slow
        // machine has not necessarily begun accepting connections by the time the wiring runs.
        // The configuration is correct either way; the arr connects when it next needs to, and
        // reachability is reported separately.
        var existing = await FindByNameAsync(resource, name, ct).ConfigureAwait(false);
        if (existing is null)
        {
            var created = await PostAsync($"{resource}?forceSave=true", desired, ct).ConfigureAwait(false);
            return created as JsonObject ?? desired;
        }

        var id = existing["id"]?.GetValue<int>() ?? 0;
        var merged = desired.DeepClone().AsObject();
        merged["id"] = id;
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

    /// <summary>
    /// True when a provider resource declares a field, whatever its value.
    /// </summary>
    /// <remarks>
    /// Distinct from <see cref="GetField"/>, which answers with the field's *value* — and a
    /// declared field whose default is empty is indistinguishable from an absent one that way.
    /// Which of those it is decides whether a client authenticates with a key or a password, so
    /// the difference is load-bearing rather than pedantic.
    /// </remarks>
    public static bool HasField(JsonObject provider, string fieldName)
    {
        ArgumentNullException.ThrowIfNull(provider);
        return provider["fields"] is JsonArray fields
            && fields.OfType<JsonObject>().Any(e =>
                string.Equals(e["name"]?.GetValue<string>(), fieldName, StringComparison.Ordinal));
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

    /// <summary>
    /// Run the app's own connectivity test for a provider resource.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the endpoint upstream's own "Test" button calls. Its contract is unusual and the
    /// unusual half is the useful half: <strong>success is an empty 200/202 body</strong>, and a
    /// failure is a <c>400</c> whose body is an array of
    /// <c>{ propertyName, errorMessage, isWarning }</c>. So a non-success status is not an error
    /// to propagate — it is the answer — which is why this returns a result rather than throwing.
    /// </para>
    /// <para>
    /// A transport failure (the app is not running at all) is still an exception, because that is a
    /// different question from "the indexer rejected the key".
    /// </para>
    /// </remarks>
    public async Task<ProviderTestResult> TestProviderAsync(
        string resource,
        JsonObject desired,
        CancellationToken ct = default)
    {
        using var req = Request(HttpMethod.Post, $"{resource}/test");
        req.Content = new StringContent(desired.ToJsonString(), Encoding.UTF8, "application/json");

        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        if (res.IsSuccessStatusCode)
        {
            return new ProviderTestResult { Ok = true, Message = $"{Name} accepted it." };
        }

        return new ProviderTestResult
        {
            Ok = false,
            Message = DescribeValidationFailure(text, res.StatusCode),
            Status = (int)res.StatusCode,
        };
    }

    /// <summary>
    /// Turn NzbDrone's validation-failure array into one sentence.
    /// </summary>
    /// <remarks>
    /// The array is what the app's own UI renders field by field; a StingStream caller has one
    /// message box, so the property names are folded in rather than dropped — "ApiKey: Unauthorized"
    /// says which half of a Torznab URL is wrong, and "Unauthorized" on its own does not.
    /// </remarks>
    public static string DescribeValidationFailure(string body, HttpStatusCode status)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return $"{(int)status} {status}";
        }

        try
        {
            if (JsonNode.Parse(body) is JsonArray failures && failures.Count > 0)
            {
                var lines = failures
                    .OfType<JsonObject>()
                    .Select(f =>
                    {
                        var property = f["propertyName"]?.GetValue<string>();
                        var message = f["errorMessage"]?.GetValue<string>()
                            ?? f["detailedDescription"]?.GetValue<string>()
                            ?? "failed";
                        return string.IsNullOrWhiteSpace(property) ? message : $"{property}: {message}";
                    })
                    .Where(s => !string.IsNullOrWhiteSpace(s))
                    .ToList();
                if (lines.Count > 0)
                {
                    return string.Join("; ", lines);
                }
            }

            // A ProblemDetails-shaped body, which is what a 500 out of the app looks like.
            if (JsonNode.Parse(body) is JsonObject obj)
            {
                var message = obj["message"]?.GetValue<string>()
                    ?? obj["errorMessage"]?.GetValue<string>()
                    ?? obj["title"]?.GetValue<string>();
                if (!string.IsNullOrWhiteSpace(message))
                {
                    return message;
                }
            }
        }
        catch (JsonException)
        {
            // Not JSON at all. The raw text is still the best thing to show.
        }

        return Truncate(body);
    }

    // --- versions ----------------------------------------------------------

    /// <summary>The app's own version string, or null when it is not answering.</summary>
    public async Task<string?> VersionAsync(CancellationToken ct = default)
    {
        try
        {
            var status = await GetAsync("system/status", ct).ConfigureAwait(false);
            return (status as JsonObject)?["version"]?.GetValue<string>();
        }
        catch (Exception ex) when (ex is ArrApiException or HttpRequestException or TaskCanceledException)
        {
            _logger.LogDebug(ex, "{App} did not report a version", Name);
            return null;
        }
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

    /// <summary>Every quality profile this app has, verbatim.</summary>
    public Task<List<JsonObject>> QualityProfilesAsync(CancellationToken ct = default)
        => ListAsync("qualityprofile", ct);

    /// <summary>One quality profile by name, or null.</summary>
    public async Task<JsonObject?> QualityProfileByNameAsync(string name, CancellationToken ct = default)
    {
        var profiles = await QualityProfilesAsync(ct).ConfigureAwait(false);
        return profiles.FirstOrDefault(p =>
            string.Equals(p["name"]?.GetValue<string>(), name, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// The app's own blank quality profile, with its complete quality tree filled in.
    /// </summary>
    /// <remarks>
    /// The same reasoning as <see cref="GetSchemaAsync"/>: a profile's <c>items</c> array is the
    /// app's whole quality definition list, in its own order, with its own groups — Radarr's and
    /// Sonarr's differ from each other and from release to release. Building one by hand would be
    /// a copy of upstream's seed data that goes stale silently; asking the app produces one that
    /// is correct for the version actually running.
    /// </remarks>
    public async Task<JsonObject?> QualityProfileSchemaAsync(CancellationToken ct = default)
        => await GetAsync("qualityprofile/schema", ct).ConfigureAwait(false) as JsonObject;

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

    /// <summary>
    /// Every candidate the app's metadata lookup returns for a typed term.
    /// </summary>
    /// <remarks>
    /// <see cref="LookupAsync"/> is the add path, which wants exactly one answer for
    /// <c>tmdb:1234</c>. This is the *search* path, which wants the list — and the two must stay
    /// separate, because a search that silently took the first result would add the wrong film.
    /// </remarks>
    public async Task<List<JsonObject>> LookupManyAsync(string term, CancellationToken ct = default)
    {
        var path = Kind == ArrKind.Radarr
            ? $"movie/lookup?term={Uri.EscapeDataString(term)}"
            : $"series/lookup?term={Uri.EscapeDataString(term)}";
        var node = await GetAsync(path, ct).ConfigureAwait(false);
        return node switch
        {
            JsonArray arr => arr.OfType<JsonObject>().ToList(),
            JsonObject one => new List<JsonObject> { one },
            _ => new List<JsonObject>(),
        };
    }

    /// <summary>Trigger one of the app's named commands, e.g. <c>MoviesSearch</c> or <c>RefreshSeries</c>.</summary>
    public Task<JsonNode?> CommandAsync(JsonObject command, CancellationToken ct = default)
        => PostAsync("command", command, ct);

    // --- calendar and history ----------------------------------------------

    /// <summary>
    /// Everything releasing between two dates.
    /// </summary>
    /// <remarks>
    /// <c>unmonitored=true</c> because the screen showing this is a management screen: "the season
    /// I stopped monitoring starts on Thursday" is exactly the row a user is looking for, and
    /// leaving it out would make the calendar quietly disagree with the library list beside it.
    /// </remarks>
    public async Task<List<JsonObject>> CalendarAsync(
        DateTime startUtc,
        DateTime endUtc,
        CancellationToken ct = default)
    {
        var path = string.Create(
            CultureInfo.InvariantCulture,
            $"calendar?start={startUtc:yyyy-MM-dd}&end={endUtc:yyyy-MM-dd}&unmonitored=true&includeSeries=true&includeEpisodeFile=true");
        return await ListAsync(path, ct).ConfigureAwait(false);
    }

    /// <summary>One page of the app's own history table, newest first.</summary>
    /// <returns>The page's records and the total the app reports.</returns>
    public async Task<(List<JsonObject> Records, int Total)> HistoryAsync(
        int page,
        int pageSize,
        CancellationToken ct = default)
    {
        var path = string.Create(
            CultureInfo.InvariantCulture,
            $"history?page={Math.Max(page, 1)}&pageSize={Math.Clamp(pageSize, 1, 200)}&sortKey=date&sortDirection=descending");
        var node = await GetAsync(path, ct).ConfigureAwait(false);
        if (node is JsonObject paged)
        {
            var records = paged["records"] is JsonArray arr
                ? arr.OfType<JsonObject>().ToList()
                : new List<JsonObject>();
            return (records, paged["totalRecords"]?.GetValue<int>() ?? records.Count);
        }

        var flat = node is JsonArray plain ? plain.OfType<JsonObject>().ToList() : new List<JsonObject>();
        return (flat, flat.Count);
    }

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

    /// <summary>
    /// Replace a library item, which is how <c>monitored</c> and the quality profile are changed.
    /// </summary>
    /// <remarks>
    /// Both apps' library <c>PUT</c> takes the whole resource, not a patch, so the caller reads the
    /// current one, edits the fields it owns and posts the result back. Sonarr additionally accepts
    /// <c>?moveFiles=false</c>, which is the default and is stated explicitly so a future upstream
    /// change of that default cannot silently start moving somebody's library.
    /// </remarks>
    public async Task<JsonObject?> UpdateLibraryItemAsync(
        int id,
        JsonObject resource,
        CancellationToken ct = default)
    {
        var path = string.Create(
            CultureInfo.InvariantCulture,
            $"{LibraryResource}/{id}?moveFiles=false");
        return await PutAsync(path, resource, ct).ConfigureAwait(false) as JsonObject;
    }

    /// <summary>Delete a library item, optionally taking its files with it.</summary>
    /// <remarks>
    /// <c>addImportExclusion=false</c> deliberately: an exclusion means "never let this back in",
    /// which is a much larger promise than the delete button a user just pressed, and it is not
    /// visible anywhere in StingStream's UI to undo.
    /// </remarks>
    public Task DeleteLibraryItemAsync(int id, bool deleteFiles, CancellationToken ct = default)
    {
        var flag = deleteFiles ? "true" : "false";
        var path = string.Create(
            CultureInfo.InvariantCulture,
            $"{LibraryResource}/{id}?deleteFiles={flag}&addImportExclusion=false");
        return DeleteAsync(path, ct);
    }

    /// <summary>Format a number the way NzbDrone's JSON expects, with no locale surprises.</summary>
    internal static string Invariant(int value) => value.ToString(CultureInfo.InvariantCulture);
}

/// <summary>What one of the apps said when asked to test a provider resource.</summary>
public sealed class ProviderTestResult
{
    /// <summary>True when the app accepted the configuration.</summary>
    public bool Ok { get; set; }

    /// <summary>A sentence for a person: the app's own validation failures, folded onto one line.</summary>
    public string Message { get; set; } = string.Empty;

    /// <summary>The HTTP status the app answered with, when it was not a success.</summary>
    public int? Status { get; set; }
}
