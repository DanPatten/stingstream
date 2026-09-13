using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace StingStream.Core.Requests;

/// <summary>
/// What a title scored on IMDb and Rotten Tomatoes, for the Requests screen.
/// </summary>
/// <remarks>
/// <para>
/// The catalogue's own score is TMDB's average, and it used to be drawn as a star that read as IMDb
/// and was not. These are the two numbers people actually choose by. Dan, 2026-09-12: every film and
/// show on the Requests tab shows both.
/// </para>
/// <para>
/// <strong>Neither has a published API, and this is written for that.</strong> IMDb's is the GraphQL
/// endpoint its own site reads, and Rotten Tomatoes' is the search index its own site queries. Both
/// answer unauthenticated, both take a whole page's titles in one call, and both can stop answering
/// without notice. So every call is capped, the pass is capped, every answer is remembered for a day,
/// and any failure is a missing score rather than an error: a card with a dash is a worse card, and a
/// Requests screen that failed to load over a decoration is a broken one.
/// </para>
/// </remarks>
public sealed class ExternalRatings
{
    /// <summary>Name of the <see cref="IHttpClientFactory"/> client used for rating calls.</summary>
    public const string HttpClientName = "StingStream.Ratings";

    /// <summary>The most titles one call answers. A feed page is sixty.</summary>
    public const int MaxTitles = 100;

    private const string ImdbEndpoint = "https://caching.graphql.imdb.com/";

    private const string ImdbQuery =
        "query Ratings($ids: [ID!]!) { titles(ids: $ids) { id ratingsSummary { aggregateRating voteCount } } }";

    /// <summary>
    /// Rotten Tomatoes' search index.
    /// </summary>
    /// <remarks>
    /// The application id and key are the public, search-only pair the site ships to every browser
    /// that loads it. They grant nothing but the search the site itself runs.
    /// </remarks>
    private const string RottenTomatoesEndpoint = "https://79frdp12pn-dsn.algolia.net/1/indexes/*/queries";

    private const string RottenTomatoesApplication = "79FRDP12PN";

    private const string RottenTomatoesApiKey = "175588f6e5f8319b27702e4cc4013561";

    /// <summary>How many titles go in one upstream call.</summary>
    private const int ChunkSize = 50;

    /// <summary>How many IMDb ids are resolved through the catalogue at once.</summary>
    private const int IdConcurrency = 6;

    /// <summary>Ceiling on one HTTP call.</summary>
    private static readonly TimeSpan _callTimeout = TimeSpan.FromSeconds(5);

    /// <summary>Ceiling on one whole answer, however many calls it takes.</summary>
    private static readonly TimeSpan _passTimeout = TimeSpan.FromSeconds(8);

    /// <summary>How long a score is reused. Neither moves much in a day.</summary>
    private static readonly TimeSpan _ttl = TimeSpan.FromHours(24);

    private readonly TmdbCatalog _catalogue;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<ExternalRatings> _logger;

    private readonly ConcurrentDictionary<string, (DateTime At, ImdbScore? Score)> _imdb =
        new(StringComparer.Ordinal);

    private readonly ConcurrentDictionary<string, (DateTime At, RottenTomatoesScore? Score)> _rottenTomatoes =
        new(StringComparer.Ordinal);

    public ExternalRatings(
        TmdbCatalog catalogue,
        IHttpClientFactory httpFactory,
        ILogger<ExternalRatings> logger)
    {
        _catalogue = catalogue;
        _httpFactory = httpFactory;
        _logger = logger;
    }

    /// <summary>
    /// The scores for a list of titles, in the order they were asked about.
    /// </summary>
    /// <param name="titles">What a screen is drawing.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>One answer per title, the first <see cref="MaxTitles"/> only. A score nobody could find is null.</returns>
    public async Task<IReadOnlyList<TitleRatings>> RatingsAsync(
        IReadOnlyList<TitleRatingsQuery> titles,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(titles);

        var wanted = titles.Take(MaxTitles).ToList();
        if (wanted.Count == 0)
        {
            return Array.Empty<TitleRatings>();
        }

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(_passTimeout);

        var imdbIds = await ImdbIdsAsync(wanted, budget.Token).ConfigureAwait(false);

        // Both services at once: they are unrelated, and the slower of the two is the whole wait.
        await Task.WhenAll(
                FillImdbAsync(imdbIds.OfType<string>().ToList(), budget.Token),
                FillRottenTomatoesAsync(wanted, budget.Token))
            .ConfigureAwait(false);

        var answers = new List<TitleRatings>(wanted.Count);
        for (var i = 0; i < wanted.Count; i++)
        {
            var answer = new TitleRatings { ImdbId = imdbIds[i] };

            // An expired entry is still used. Yesterday's score is a good card; a dash because the
            // refresh failed this minute is not.
            if (imdbIds[i] is { } id && _imdb.TryGetValue(id, out var imdb) && imdb.Score is { } imdbScore)
            {
                answer.ImdbRating = imdbScore.Rating;
                answer.ImdbVotes = imdbScore.Votes;
            }

            if (RottenTomatoesKey(wanted[i]) is { } key
                && _rottenTomatoes.TryGetValue(key, out var tomatoes)
                && tomatoes.Score is { } tomatoesScore)
            {
                answer.RottenTomatoesScore = tomatoesScore.Critics;
                answer.RottenTomatoesAudienceScore = tomatoesScore.Audience;
                answer.RottenTomatoesUrl = tomatoesScore.Url;
            }

            answers.Add(answer);
        }

        return answers;
    }

    // --- parsing, static so it can be tested without a network --------------

    /// <summary>The scores out of one IMDb answer, by id.</summary>
    /// <param name="body">The GraphQL response.</param>
    /// <returns>Every title it answered about, or null when the answer is not the shape asked for.</returns>
    /// <remarks>
    /// Null and empty are different on purpose. A title IMDb knows and nobody has rated comes back
    /// with a null rating and is remembered as unrated; an answer with no <c>data</c> at all is an
    /// error, and remembering it would blank every title in the batch for a day.
    /// </remarks>
    public static Dictionary<string, ImdbScore>? ImdbScoresFrom(JsonNode? body)
    {
        if (body?["data"]?["titles"] is not JsonArray titles)
        {
            return null;
        }

        var scores = new Dictionary<string, ImdbScore>(StringComparer.Ordinal);
        foreach (var title in titles.OfType<JsonObject>())
        {
            var id = Text(title["id"]);
            if (id is null)
            {
                continue;
            }

            var summary = title["ratingsSummary"];
            var rating = Number(summary?["aggregateRating"]);
            var votes = Number(summary?["voteCount"]);
            scores[id] = new ImdbScore(
                rating is > 0 ? rating : null,
                votes is > 0 ? (int)votes.Value : null);
        }

        return scores;
    }

    /// <summary>
    /// The Rotten Tomatoes page for a title, out of one search's hits.
    /// </summary>
    /// <param name="result">One entry of the search response's <c>results</c>.</param>
    /// <param name="isMovie">Whether the title is a film.</param>
    /// <param name="title">The title as the catalogue names it.</param>
    /// <param name="year">Its release year, when known.</param>
    /// <returns>The match, or null when nothing is close enough to be sure of.</returns>
    /// <remarks>
    /// <para>
    /// <strong>Strict, because a wrong score looks exactly like a right one.</strong> A search for
    /// "Dune" answers with both films, and nothing on a card would say which one's score it is. So a
    /// hit needs the year within one (release dates differ by a year between countries) and the same
    /// title, among its title, its alternative titles and its alternative names.
    /// </para>
    /// <para>
    /// The one looser case is a title that only adds a subtitle, which Rotten Tomatoes does to shows:
    /// "Arcane" is listed as "Arcane: League of Legends". That is accepted only in the same year, since
    /// "Alien" with no year to check would otherwise take the score of "Alien Nation".
    /// </para>
    /// </remarks>
    public static RottenTomatoesScore? RottenTomatoesFrom(JsonNode? result, bool isMovie, string? title, int? year)
    {
        var wanted = Normalise(title);
        if (wanted.Length == 0 || result?["hits"] is not JsonArray hits)
        {
            return null;
        }

        JsonObject? best = null;
        var bestRank = int.MaxValue;
        foreach (var hit in hits.OfType<JsonObject>())
        {
            var hitYear = (int?)Number(hit["releaseYear"]);
            var knownYears = year is > 0 && hitYear is > 0;
            var distance = knownYears ? Math.Abs(year!.Value - hitYear!.Value) : 0;
            if (distance > 1)
            {
                continue;
            }

            var names = NamesOf(hit);
            int rank;
            if (names.Contains(wanted, StringComparer.Ordinal))
            {
                rank = distance;
            }
            else if (knownYears && distance == 0 && names.Any(name => ExtendsTitle(name, wanted)))
            {
                rank = 2;
            }
            else
            {
                continue;
            }

            if (rank < bestRank)
            {
                best = hit;
                bestRank = rank;
            }
        }

        var vanity = Text(best?["vanity"]);
        if (best is null || vanity is null)
        {
            return null;
        }

        var scores = best["rottenTomatoes"];
        var critics = Number(scores?["criticsScore"]);
        var audience = Number(scores?["audienceScore"]);
        return new RottenTomatoesScore(
            critics is >= 0 ? (int)critics.Value : null,
            audience is >= 0 ? (int)audience.Value : null,
            "https://www.rottentomatoes.com/" + (isMovie ? "m/" : "tv/") + Uri.EscapeDataString(vanity));
    }

    /// <summary>An IMDb id as given, or null when it is not one.</summary>
    /// <param name="value">Anything.</param>
    /// <returns><c>tt</c> and seven to ten digits, or null.</returns>
    /// <remarks>Checked before it goes upstream, so a bad id cannot fail the whole batch it is in.</remarks>
    public static string? ImdbIdOrNull(string? value)
    {
        var id = value?.Trim();
        if (id is null || id.Length < 9 || id.Length > 12 || !id.StartsWith("tt", StringComparison.Ordinal))
        {
            return null;
        }

        for (var i = 2; i < id.Length; i++)
        {
            if (!char.IsAsciiDigit(id[i]))
            {
                return null;
            }
        }

        return id;
    }

    // --- fetching -----------------------------------------------------------

    /// <summary>Each title's IMDb id, from the query when it carried one and the catalogue when not.</summary>
    private async Task<string?[]> ImdbIdsAsync(IReadOnlyList<TitleRatingsQuery> titles, CancellationToken cancellationToken)
    {
        using var slots = new SemaphoreSlim(IdConcurrency);
        var work = titles.Select(async title =>
        {
            var given = ImdbIdOrNull(title.ImdbId);
            if (given is not null)
            {
                return given;
            }

            try
            {
                await slots.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return null;
            }

            try
            {
                return ImdbIdOrNull(await _catalogue
                    .ImdbIdAsync(IsMovie(title), title.TmdbId, title.TvdbId, cancellationToken)
                    .ConfigureAwait(false));
            }
            catch (OperationCanceledException)
            {
                // The budget ran out. The title keeps its Rotten Tomatoes score, which needs no id.
                return null;
            }
            finally
            {
                slots.Release();
            }
        });

        return await Task.WhenAll(work).ConfigureAwait(false);
    }

    private async Task FillImdbAsync(IReadOnlyList<string> ids, CancellationToken cancellationToken)
    {
        var missing = ids.Distinct(StringComparer.Ordinal).Where(id => !Fresh(_imdb, id)).ToList();
        foreach (var chunk in missing.Chunk(ChunkSize))
        {
            var body = new JsonObject
            {
                ["query"] = ImdbQuery,
                ["variables"] = new JsonObject
                {
                    ["ids"] = new JsonArray(chunk.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
                },
            };

            var answer = await PostAsync(
                    ImdbEndpoint,
                    body,
                    headers => headers.TryAddWithoutValidation("x-imdb-client-name", "imdb-web-next-localized"),
                    cancellationToken)
                .ConfigureAwait(false);

            var scores = ImdbScoresFrom(answer);
            if (scores is null)
            {
                continue;
            }

            var now = DateTime.UtcNow;
            foreach (var id in chunk)
            {
                _imdb[id] = (now, scores.TryGetValue(id, out var score) ? score : null);
            }
        }
    }

    private async Task FillRottenTomatoesAsync(IReadOnlyList<TitleRatingsQuery> titles, CancellationToken cancellationToken)
    {
        // Films and shows are separate searches, because the index filters by type and a show
        // sharing a film's name is exactly the wrong answer the filter is there to exclude.
        var missing = titles
            .Select(title => (Title: title, Key: RottenTomatoesKey(title)))
            .Where(entry => entry.Key is not null && !Fresh(_rottenTomatoes, entry.Key))
            .GroupBy(entry => entry.Key, StringComparer.Ordinal)
            .Select(group => group.First().Title)
            .ToList();

        foreach (var chunk in missing.Chunk(ChunkSize))
        {
            var requests = new JsonArray();
            foreach (var title in chunk)
            {
                var type = IsMovie(title) ? "movie" : "tv";
                requests.Add(new JsonObject
                {
                    ["indexName"] = "content_rt",
                    ["query"] = title.Title,
                    ["params"] = "filters=" + Uri.EscapeDataString($"isEmsSearchable = 1 AND type:\"{type}\"")
                                 + "&hitsPerPage=10&attributesToRetrieve="
                                 + Uri.EscapeDataString("title,titles,aka,releaseYear,vanity,rottenTomatoes"),
                });
            }

            var answer = await PostAsync(
                    RottenTomatoesEndpoint,
                    new JsonObject { ["requests"] = requests },
                    headers =>
                    {
                        headers.TryAddWithoutValidation("x-algolia-application-id", RottenTomatoesApplication);
                        headers.TryAddWithoutValidation("x-algolia-api-key", RottenTomatoesApiKey);
                    },
                    cancellationToken)
                .ConfigureAwait(false);

            if (answer?["results"] is not JsonArray results)
            {
                continue;
            }

            var now = DateTime.UtcNow;
            for (var i = 0; i < chunk.Length && i < results.Count; i++)
            {
                var title = chunk[i];
                _rottenTomatoes[RottenTomatoesKey(title)!] =
                    (now, RottenTomatoesFrom(results[i], IsMovie(title), title.Title, title.Year));
            }
        }
    }

    /// <summary>One POST, with every failure flattened to null.</summary>
    private async Task<JsonNode?> PostAsync(
        string url,
        JsonObject body,
        Action<HttpRequestHeaders> headers,
        CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_callTimeout);
        try
        {
            using var http = _httpFactory.CreateClient(HttpClientName);
            using var request = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
            };
            request.Headers.UserAgent.ParseAdd("StingStream/1.0");
            headers(request.Headers);

            using var response = await http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogDebug("{Url} answered {Status} for a ratings lookup", url, (int)response.StatusCode);
                return null;
            }

            var text = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
            return string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or OperationCanceledException)
        {
            _logger.LogDebug(ex, "{Url} did not answer a ratings lookup", url);
            return null;
        }
    }

    // --- helpers ------------------------------------------------------------

    private static bool IsMovie(TitleRatingsQuery title)
        => !string.Equals(title.Kind, "series", StringComparison.OrdinalIgnoreCase);

    private static string? RottenTomatoesKey(TitleRatingsQuery title)
    {
        var name = Normalise(title.Title);
        return name.Length == 0
            ? null
            : string.Create(
                CultureInfo.InvariantCulture,
                $"{(IsMovie(title) ? "movie" : "tv")}|{name}|{title.Year ?? 0}");
    }

    private static bool Fresh<T>(ConcurrentDictionary<string, (DateTime At, T Score)> cache, string? key)
        => key is not null && cache.TryGetValue(key, out var entry) && DateTime.UtcNow - entry.At <= _ttl;

    /// <summary>A hit's title, alternative titles and alternative names, normalised.</summary>
    private static List<string> NamesOf(JsonObject hit)
    {
        var names = new List<string>();
        void Add(JsonNode? node)
        {
            var name = Normalise(Text(node));
            if (name.Length > 0)
            {
                names.Add(name);
            }
        }

        Add(hit["title"]);
        foreach (var field in new[] { "titles", "aka" })
        {
            if (hit[field] is JsonArray more)
            {
                foreach (var node in more)
                {
                    Add(node);
                }
            }
        }

        return names;
    }

    /// <summary>Whether <paramref name="name"/> is <paramref name="wanted"/> with a subtitle after it.</summary>
    private static bool ExtendsTitle(string name, string wanted)
        => name.Length > wanted.Length
           && name.StartsWith(wanted, StringComparison.Ordinal)
           && name[wanted.Length] == ' ';

    /// <summary>Case, punctuation and spacing folded away, so "WALL·E" and "Wall-E" compare equal.</summary>
    private static string Normalise(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(value.Length);
        var pendingSpace = false;
        foreach (var ch in value)
        {
            if (char.IsLetterOrDigit(ch))
            {
                if (pendingSpace && builder.Length > 0)
                {
                    builder.Append(' ');
                }

                pendingSpace = false;
                builder.Append(char.ToLowerInvariant(ch));
            }
            else
            {
                pendingSpace = true;
            }
        }

        return builder.ToString();
    }

    private static string? Text(JsonNode? node)
        => node is JsonValue value && value.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text)
            ? text
            : null;

    private static double? Number(JsonNode? node)
        => node is JsonValue value && value.TryGetValue<double>(out var number) ? number : null;
}

/// <summary>An IMDb rating out of ten and how many people gave it.</summary>
/// <param name="Rating">The rating, or null when nobody has rated it.</param>
/// <param name="Votes">How many votes, or null.</param>
public readonly record struct ImdbScore(double? Rating, int? Votes);

/// <summary>A Rotten Tomatoes match.</summary>
/// <param name="Critics">The critics' score as a percentage, or null when there is none yet.</param>
/// <param name="Audience">The audience score as a percentage, or null.</param>
/// <param name="Url">The title's own page.</param>
public readonly record struct RottenTomatoesScore(int? Critics, int? Audience, string Url);

/// <summary>One title a screen wants scores for.</summary>
public sealed class TitleRatingsQuery
{
    /// <summary><c>movie</c> or <c>series</c>.</summary>
    public string Kind { get; set; } = "movie";

    /// <summary>A film's TMDB id, when the caller has one.</summary>
    public int TmdbId { get; set; }

    /// <summary>A show's TVDB id, when the caller has one.</summary>
    public int TvdbId { get; set; }

    /// <summary>The IMDb id, when the caller already has it. Saves a lookup.</summary>
    public string? ImdbId { get; set; }

    /// <summary>The title, which is what Rotten Tomatoes is searched by.</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>The release year, which is what tells a remake from the original.</summary>
    public int? Year { get; set; }
}

/// <summary>What <c>POST /requests/ratings</c> takes.</summary>
public sealed class TitleRatingsBody
{
    /// <summary>The titles, at most <see cref="ExternalRatings.MaxTitles"/>.</summary>
    public List<TitleRatingsQuery> Titles { get; set; } = new();
}

/// <summary>One title's scores. Every field may be null.</summary>
public sealed class TitleRatings
{
    /// <summary>The IMDb id the rating was read for, so the app can link to the right page.</summary>
    public string? ImdbId { get; set; }

    /// <summary>Out of ten.</summary>
    public double? ImdbRating { get; set; }

    public int? ImdbVotes { get; set; }

    /// <summary>The critics' score, a percentage.</summary>
    public int? RottenTomatoesScore { get; set; }

    /// <summary>The audience score, a percentage.</summary>
    public int? RottenTomatoesAudienceScore { get; set; }

    /// <summary>The page the score was matched to.</summary>
    public string? RottenTomatoesUrl { get; set; }
}
