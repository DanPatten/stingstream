using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace StingStream.Core.Requests;

/// <summary>
/// A poster for a series the arrs had none for.
/// </summary>
/// <remarks>
/// <para>
/// Sonarr's lookup returns whatever TVDB holds, and for a long tail of shows TVDB holds no artwork
/// at all: measured across six searches on a real node, 13.3% of series results came back with an
/// empty <c>images</c> array, against 4.2% of films. TVmaze is asked about those, and only those.
/// </para>
/// <para>
/// <strong>Why TVmaze.</strong> It needs no API key, which was the requirement, and of the keyless
/// options it was the only one with both a usable id-keyed path and the right aspect ratio. Against
/// the 19 posterless series in that sample it filled four: one by exact TVDB id, three by title and
/// year. The iTunes Search API filled two and returns square artwork, which is the wrong shape for a
/// 2:3 poster box. Cinemeta is IMDb-keyed and only ten of the nineteen carried an IMDb id.
/// </para>
/// <para>
/// <strong>What this is not.</strong> It is not a metadata provider and must never become the reason
/// a search is slow. Every call is capped, the whole pass is capped, and a failure at any point
/// leaves the result exactly as it arrived: no poster, and the app draws its placeholder tile. That
/// is the behaviour we shipped before this class existed, so the worst case is a return to it.
/// </para>
/// </remarks>
public sealed class ArtworkFallback
{
    /// <summary>Name of the <see cref="IHttpClientFactory"/> client used for artwork lookups.</summary>
    public const string HttpClientName = "StingStream.Artwork";

    /// <summary>The id space this caches under, so a future second provider does not collide.</summary>
    private const string Provider = "tvdb";

    private const string BaseUrl = "https://api.tvmaze.com";

    /// <summary>
    /// How many titles one search may look up.
    /// </summary>
    /// <remarks>
    /// TVmaze allows roughly 20 calls per 10 seconds per IP, and a wide search can have nineteen
    /// gaps in it. The cap plus the cache keeps a burst well inside that; the titles beyond it keep
    /// their placeholder this time and are filled on a later search, because the ones that did run
    /// are now cached.
    /// </remarks>
    private const int MaxPerSearch = 8;

    /// <summary>How many lookups run at once.</summary>
    private const int Concurrency = 4;

    /// <summary>Ceiling on one HTTP call.</summary>
    private static readonly TimeSpan _callTimeout = TimeSpan.FromSeconds(2);

    /// <summary>Ceiling on the whole fill pass, however many titles are in it.</summary>
    private static readonly TimeSpan _passTimeout = TimeSpan.FromSeconds(3);

    private readonly RequestStore _store;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<ArtworkFallback> _logger;

    public ArtworkFallback(
        RequestStore store,
        IHttpClientFactory httpFactory,
        ILogger<ArtworkFallback> logger)
    {
        _store = store;
        _httpFactory = httpFactory;
        _logger = logger;
    }

    /// <summary>
    /// Fill in posters for the series results that have none.
    /// </summary>
    /// <param name="results">The search results, modified in place.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    /// <remarks>
    /// Deliberately kept out of the per-result loop in <see cref="RequestService.SearchAsync"/>:
    /// that loop is sequential and already does mesh work per result, and artwork must not extend
    /// it. This is one bounded pass over only the gaps.
    /// </remarks>
    public async Task FillAsync(
        IReadOnlyList<RequestSearchResult> results,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(results);

        var gaps = results
            .Where(r => string.IsNullOrWhiteSpace(r.PosterUrl) && r.TvdbId > 0)
            .ToList();
        if (gaps.Count == 0)
        {
            return;
        }

        // The cached answers first, and for free. On a repeated search this usually empties the
        // list, including for the titles that are known to have nothing.
        var pending = new List<RequestSearchResult>();
        foreach (var gap in gaps)
        {
            if (_store.TryCachedArtwork(Provider, gap.TvdbId, out var cached))
            {
                gap.PosterUrl = cached;
            }
            else
            {
                pending.Add(gap);
            }
        }

        if (pending.Count == 0)
        {
            return;
        }

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(_passTimeout);

        using var slots = new SemaphoreSlim(Concurrency);
        var work = pending
            .Take(MaxPerSearch)
            .Select(async gap =>
            {
                await slots.WaitAsync(budget.Token).ConfigureAwait(false);
                try
                {
                    var poster = await PosterForSeriesAsync(
                        gap.TvdbId,
                        gap.Title,
                        gap.Year,
                        budget.Token).ConfigureAwait(false);

                    // Cached either way. The miss is the more valuable of the two to remember.
                    await _store.CacheArtworkAsync(Provider, gap.TvdbId, poster, cancellationToken)
                        .ConfigureAwait(false);
                    if (poster is not null)
                    {
                        gap.PosterUrl = poster;
                    }
                }
                finally
                {
                    slots.Release();
                }
            });

        try
        {
            await Task.WhenAll(work).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // The pass ran out of its budget. Whatever was filled stays filled, the rest keep the
            // placeholder, and nothing is cached for the ones that did not finish -- so a later
            // search tries them again rather than remembering a timeout as a miss.
            _logger.LogDebug("Artwork lookups did not finish inside {Budget}", _passTimeout);
        }
    }

    /// <summary>
    /// Ask TVmaze for one series' poster.
    /// </summary>
    /// <param name="tvdbId">The TVDB id the arr gave us.</param>
    /// <param name="title">The arr's title, for the fallback match.</param>
    /// <param name="year">The arr's year. Without one, only the id match can be trusted.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The poster URL, or null when nothing certain was found.</returns>
    public async Task<string?> PosterForSeriesAsync(
        int tvdbId,
        string? title,
        int? year,
        CancellationToken cancellationToken)
    {
        // An exact id match. Trusted unconditionally: TVmaze is being asked "which of your shows is
        // this TVDB id", and there is only ever one answer.
        var byId = await GetAsync(
            $"/lookup/shows?thetvdb={tvdbId.ToString(CultureInfo.InvariantCulture)}",
            cancellationToken).ConfigureAwait(false);
        var poster = PosterOf(byId as JsonObject);
        if (poster is not null)
        {
            return poster;
        }

        if (string.IsNullOrWhiteSpace(title) || year is not > 0)
        {
            return null;
        }

        // Falling back to the name. Every candidate goes through ArtworkMatch, which requires the
        // normalised title and the year to both agree -- see that class for the wrong-poster
        // measurement this rule comes from.
        var found = await GetAsync(
            $"/search/shows?q={Uri.EscapeDataString(title)}",
            cancellationToken).ConfigureAwait(false);
        if (found is not JsonArray candidates)
        {
            return null;
        }

        foreach (var show in candidates.OfType<JsonObject>()
                     .Select(c => c["show"] as JsonObject)
                     .Where(s => s is not null))
        {
            if (ArtworkMatch.IsAcceptable(
                    show!["name"]?.GetValue<string>(),
                    show["premiered"]?.GetValue<string>(),
                    title,
                    year))
            {
                var candidate = PosterOf(show);
                if (candidate is not null)
                {
                    return candidate;
                }
            }
        }

        return null;
    }

    /// <summary>The poster URL on a TVmaze show object, if it carries one.</summary>
    private static string? PosterOf(JsonObject? show)
    {
        var url = show?["image"]?["original"]?.GetValue<string>()
                  ?? show?["image"]?["medium"]?.GetValue<string>();
        return string.IsNullOrWhiteSpace(url) ? null : url;
    }

    /// <summary>
    /// One GET against TVmaze, parsed, with every failure flattened to null.
    /// </summary>
    /// <remarks>
    /// A 404 is TVmaze's ordinary answer for "no show with that id", which is the common case here
    /// rather than an error. Everything else -- a timeout, a rate limit, DNS, malformed JSON -- is
    /// equally not worth surfacing: the caller's fallback for all of them is the placeholder tile.
    /// </remarks>
    private async Task<JsonNode?> GetAsync(string path, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_callTimeout);
        try
        {
            using var http = _httpFactory.CreateClient(HttpClientName);
            using var response = await http
                .GetAsync(BaseUrl + path, timeout.Token)
                .ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            var body = await response.Content
                .ReadAsStringAsync(timeout.Token)
                .ConfigureAwait(false);
            return string.IsNullOrWhiteSpace(body) ? null : JsonNode.Parse(body);
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or OperationCanceledException)
        {
            _logger.LogDebug(ex, "Artwork lookup {Path} did not answer", path);
            return null;
        }
    }
}
