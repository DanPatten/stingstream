using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Providers.Plugins.Tmdb;
using Microsoft.Extensions.Logging;
using StingStream.Core.Inventory;

namespace StingStream.Core.Requests;

/// <summary>
/// The catalogue behind the Find screen: what is popular, what is best, and what matches a filter.
/// </summary>
/// <remarks>
/// <para>
/// Search goes through the arrs, and should keep going through them: they hold the keys, they
/// normalise two providers onto one shape, and they are what will be asked to grab the result, so a
/// title they cannot look up is a title that could not have been added anyway.
/// </para>
/// <para>
/// <strong>Browsing is a different question and the arrs cannot answer it.</strong> "What is popular
/// right now" and "what is the best ever made" are not searches for a term. Radarr can be asked for
/// a popular list, Sonarr cannot be asked for anything of the sort, and neither has an all-time
/// rating list, so a feed built on them would be films-only and half the feature. This asks the
/// metadata provider directly, using the key the server already carries for its own library
/// metadata.
/// </para>
/// <para>
/// <strong>What this is not.</strong> It is not on the request path and it is not a source of truth.
/// Every call is capped, the whole pass is capped, and any failure returns an empty list rather than
/// throwing: a catalogue that cannot be read leaves the reader with the search box they had before
/// it existed, which is a worse screen and not a broken one.
/// </para>
/// </remarks>
public sealed class TmdbCatalog
{
    /// <summary>Name of the <see cref="IHttpClientFactory"/> client used for catalogue calls.</summary>
    public const string HttpClientName = "StingStream.Tmdb";

    /// <summary>The id space a translated series id caches under.</summary>
    private const string TmdbProvider = "tmdb";

    /// <summary>The id space series item keys are built from.</summary>
    private const string TvdbProvider = "tvdb";

    /// <summary>
    /// The id space an IMDb id caches under.
    /// </summary>
    /// <remarks>
    /// Stored as the number alone, because <c>provider_id_map</c> holds integers: <c>tt0063951</c>
    /// goes in as 63951 and comes back out through <see cref="ImdbTag"/>. Every IMDb id is
    /// <c>tt</c> and seven or eight digits, so nothing is lost either way.
    /// </remarks>
    private const string ImdbProvider = "imdb";

    /// <summary>
    /// How many seasons a show has, cached beside its ids.
    /// </summary>
    /// <remarks>
    /// Not an id, and it is in the id table anyway: it is a small integer keyed by (provider,
    /// provider id, name), which is exactly that table's shape, and it arrives on the same call
    /// that the TVDB translation does. The alternative was a second table and a second round trip
    /// per show for one number. It ages with everything else in there, so a show that gains a
    /// season shows the old count until the row expires.
    /// </remarks>
    private const string SeasonsKey = "seasons";

    private const string BaseUrl = "https://api.themoviedb.org/3";

    /// <summary>
    /// Where a poster path becomes a URL.
    /// </summary>
    /// <remarks>
    /// Hardcoded rather than read from <c>/configuration</c>, which would be a round trip on the
    /// request path for a value that has not moved in a decade. <see cref="ArtworkFallback"/>
    /// hardcodes its CDN for the same reason. <c>w500</c> is roughly twice the widest poster the
    /// grid draws, which is what the card layout asks for on a high-density screen.
    /// </remarks>
    private const string PosterBase = "https://image.tmdb.org/t/p/w500";

    /// <summary>
    /// How many upstream pages one feed is made of.
    /// </summary>
    /// <remarks>
    /// A page is twenty titles, so three is sixty: comfortably past the fifty the screen promises,
    /// and short enough that a cold feed is three calls rather than a crawl.
    /// </remarks>
    private const int PagesPerFeed = 3;

    /// <summary>How many titles the provider puts on a page. Their number, not ours.</summary>
    private const int PageSize = 20;

    /// <summary>
    /// How many votes a film needs before its rating is allowed to mean "of all time".
    /// </summary>
    /// <remarks>
    /// <para>
    /// The single most load-bearing number in this file, and it was measured rather than guessed.
    /// An unbounded average answers "the best films ever made" with nine-vote curiosities sitting
    /// at 10.0. Raising the floor to 300 was not enough either: at that level the answer was six
    /// films from the current year that nobody has heard of, because a few hundred early votes on
    /// something new out-average a classic every time.
    /// </para>
    /// <para>
    /// Measured against the live provider, ordering by rating: at 1000 the list still opened with
    /// two titles from this year ahead of <em>The Shawshank Redemption</em>; at 3000 one; at
    /// <strong>5000</strong> it is Shawshank, <em>The Godfather</em>, <em>The Godfather Part II</em>
    /// and <em>12 Angry Men</em>, which is the list somebody asking the question has in mind.
    /// Higher starts excluding older films that are genuinely canonical and simply have fewer
    /// voters.
    /// </para>
    /// <para>
    /// <strong>Their own top-rated endpoint does not do this for you.</strong> It looked like the
    /// obvious answer and it is the same raw average at a low threshold: measured the same day, it
    /// opened with the same three unknowns from this year.
    /// </para>
    /// </remarks>
    private const int MovieVoteFloor = 5000;

    /// <summary>
    /// The same floor for series, which have far fewer voters per title.
    /// </summary>
    /// <remarks>
    /// Measured the same way: at 400 the list opened with three shows nobody has heard of, and at
    /// 1000 it is <em>Breaking Bad</em>, <em>Avatar: The Last Airbender</em>, <em>Arcane</em> and
    /// <em>Chernobyl</em>. Raising it further changed nothing, so it stays where the answer settled.
    /// </remarks>
    private const int SeriesVoteFloor = 1000;

    /// <summary>
    /// A modest floor under the orders that are not about rating at all.
    /// </summary>
    /// <remarks>
    /// "Release date" over the whole catalogue is otherwise a list of festival documentaries with
    /// no votes at all, which is a true answer to the query and a useless screen. Low enough that
    /// it only excludes titles nobody has seen.
    /// </remarks>
    private const int ObscurityFloor = 50;

    /// <summary>How many titles have their ids looked up at once.</summary>
    private const int IdConcurrency = 6;

    /// <summary>
    /// How many titles a related or credits row carries.
    /// </summary>
    /// <remarks>
    /// One provider page. A row is a horizontal scroller on a page about something else, not a
    /// feed somebody came to browse, and every title past the first screenful costs a TVDB
    /// translation to be worth having.
    /// </remarks>
    private const int RowLimit = PageSize;

    /// <summary>Ceiling on one HTTP call.</summary>
    private static readonly TimeSpan _callTimeout = TimeSpan.FromSeconds(5);

    /// <summary>Ceiling on one whole feed, however many calls it takes.</summary>
    private static readonly TimeSpan _passTimeout = TimeSpan.FromSeconds(15);

    /// <summary>How long a feed page is reused. Popular moves daily at most.</summary>
    private static readonly TimeSpan _feedTtl = TimeSpan.FromHours(6);

    /// <summary>How long the genre list is reused. It changes about once a decade.</summary>
    private static readonly TimeSpan _genreTtl = TimeSpan.FromHours(24);

    private readonly RequestStore _store;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<TmdbCatalog> _logger;
    private readonly ConcurrentDictionary<string, (DateTime At, JsonNode Body)> _cache = new(StringComparer.Ordinal);

    public TmdbCatalog(
        RequestStore store,
        IHttpClientFactory httpFactory,
        ILogger<TmdbCatalog> logger)
    {
        _store = store;
        _httpFactory = httpFactory;
        _logger = logger;
    }

    /// <summary>Whether a catalogue can be read at all.</summary>
    /// <returns>True when there is a key to read it with.</returns>
    /// <remarks>
    /// The key the metadata provider ships is always present, so this is true unless somebody has
    /// deliberately blanked it. It exists so a caller can tell "no catalogue" from "empty
    /// catalogue" if that ever changes.
    /// </remarks>
    public bool CanBrowse() => !string.IsNullOrWhiteSpace(ApiKey);

    /// <summary>
    /// A page of the catalogue, before anything is known about who holds what.
    /// </summary>
    /// <param name="query">What to fetch.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The titles, in the order asked for. Empty when the catalogue could not be read.</returns>
    public async Task<IReadOnlyList<RequestSearchResult>> BrowseAsync(
        TmdbBrowseQuery query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(_passTimeout);

        try
        {
            var wantMovies = !string.Equals(query.Kind, "series", StringComparison.OrdinalIgnoreCase);
            var wantSeries = !string.Equals(query.Kind, "movie", StringComparison.OrdinalIgnoreCase);

            var results = new List<RequestSearchResult>();
            if (wantMovies)
            {
                results.AddRange(await PageAsync(query, true, budget.Token).ConfigureAwait(false));
            }

            if (wantSeries)
            {
                results.AddRange(await PageAsync(query, false, budget.Token).ConfigureAwait(false));
            }

            // Two lists become one. Films and series are fetched separately because the provider has
            // no combined endpoint, and a hard films-then-series boundary halfway down a grid with
            // no section headings reads as a rendering fault rather than as an order.
            //
            // Cut back to one feed's worth afterwards rather than by fetching half of each: taking
            // the best sixty of a hundred and twenty is what makes All a mix of the best of both,
            // where thirty films and thirty shows would be a quota.
            if (wantMovies && wantSeries)
            {
                results = Order(results, query).Take(PagesPerFeed * PageSize).ToList();
            }

            return Dedupe(results);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning("The catalogue did not answer inside {Budget}", _passTimeout);
            return Array.Empty<RequestSearchResult>();
        }
    }

    /// <summary>
    /// Search the catalogue by name, without needing a download manager to be running.
    /// </summary>
    /// <param name="term">What the person typed.</param>
    /// <param name="kind"><c>movie</c>, <c>series</c>, or null for both.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The matches, films first. Empty when the catalogue could not be read.</returns>
    /// <remarks>
    /// <para>
    /// Searching used to go only through Radarr and Sonarr, on the reasoning that a title which
    /// cannot be looked up there could not have been added anyway. That stopped being true the
    /// moment a manager only runs when an indexer covers it: a node with nothing configured could
    /// not look anything up, so the whole Requests screen was replaced by "Requests are not set up
    /// on this server". Dan: *"downloading shouldnt be required to put in requests"*. Asking for
    /// something is not the same act as fetching it, and the wanted list exists precisely so the
    /// asking can happen first.
    /// </para>
    /// <para>
    /// The provider ships its own key, so this path is always available. Results are the same shape
    /// the managers' lookup produced, because both go through
    /// <see cref="FromTmdbMovie"/>/<see cref="FromTmdbSeries"/> -- which also keeps the item keys
    /// identical, so a title found here is the same title the group index is asked about.
    /// </para>
    /// </remarks>
    public async Task<IReadOnlyList<RequestSearchResult>> SearchAsync(
        string term,
        string? kind,
        CancellationToken cancellationToken)
    {
        var trimmed = (term ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            return Array.Empty<RequestSearchResult>();
        }

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(_passTimeout);

        try
        {
            var wantMovies = !string.Equals(kind, "series", StringComparison.OrdinalIgnoreCase);
            var wantSeries = !string.Equals(kind, "movie", StringComparison.OrdinalIgnoreCase);
            var query = Uri.EscapeDataString(trimmed);

            var results = new List<RequestSearchResult>();
            if (wantMovies)
            {
                results.AddRange(await SearchPageAsync(query, true, budget.Token).ConfigureAwait(false));
            }

            if (wantSeries)
            {
                results.AddRange(await SearchPageAsync(query, false, budget.Token).ConfigureAwait(false));
            }

            return Dedupe(results);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning("The catalogue did not answer a search inside {Budget}", _passTimeout);
            return Array.Empty<RequestSearchResult>();
        }
    }

    /// <summary>One kind's worth of search results.</summary>
    /// <param name="query">The term, already URL-encoded.</param>
    /// <param name="isMovie">Whether to search films.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The matches for that kind.</returns>
    /// <remarks>
    /// One page, not the feed's several: somebody typing a name wants the title they named, and a
    /// hundred further matches for a word that happens to appear in other titles is noise. Cached
    /// on the same schedule as a feed, because a search for "alien" answers the same today as it
    /// did this morning.
    /// </remarks>
    private async Task<List<RequestSearchResult>> SearchPageAsync(
        string query,
        bool isMovie,
        CancellationToken cancellationToken)
    {
        var path = isMovie
            ? $"/search/movie?query={query}&include_adult=false"
            : $"/search/tv?query={query}&include_adult=false";

        var body = await GetAsync(path, _feedTtl, cancellationToken).ConfigureAwait(false);
        if (body?["results"] is not JsonArray entries || entries.Count == 0)
        {
            return new List<RequestSearchResult>();
        }

        var genres = await GenresAsync(isMovie, cancellationToken).ConfigureAwait(false);
        return isMovie
            ? await MoviesAsync(entries, genres, true, cancellationToken).ConfigureAwait(false)
            : await SeriesAsync(entries, genres, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>The genres this kind can be filtered by.</summary>
    /// <param name="kind"><c>movie</c>, <c>series</c>, or anything else for both.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Genre names, alphabetical, deduplicated across both kinds when both are wanted.</returns>
    public async Task<IReadOnlyList<string>> GenreNamesAsync(string? kind, CancellationToken cancellationToken)
    {
        var wantMovies = !string.Equals(kind, "series", StringComparison.OrdinalIgnoreCase);
        var wantSeries = !string.Equals(kind, "movie", StringComparison.OrdinalIgnoreCase);

        var names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        if (wantMovies)
        {
            foreach (var genre in await GenresAsync(true, cancellationToken).ConfigureAwait(false))
            {
                names.Add(genre.Value);
            }
        }

        if (wantSeries)
        {
            foreach (var genre in await GenresAsync(false, cancellationToken).ConfigureAwait(false))
            {
                names.Add(genre.Value);
            }
        }

        return names.ToList();
    }

    // --- mapping, static so it can be tested without a network --------------

    /// <summary>One film out of a discover response.</summary>
    /// <param name="entry">The provider's object.</param>
    /// <param name="genres">Genre ids to names, for the ids the entry carries.</param>
    /// <returns>The result, or null when it has no usable id.</returns>
    public static RequestSearchResult? FromTmdbMovie(JsonObject? entry, IReadOnlyDictionary<int, string> genres)
    {
        ArgumentNullException.ThrowIfNull(genres);
        var tmdbId = entry?["id"]?.GetValue<int?>() ?? 0;
        if (entry is null || tmdbId <= 0)
        {
            return null;
        }

        return new RequestSearchResult
        {
            Kind = "movie",
            Title = entry["title"]?.GetValue<string>() ?? string.Empty,
            Year = YearOf(entry["release_date"]?.GetValue<string>()),
            Overview = Blank(entry["overview"]?.GetValue<string>()),
            PosterUrl = PosterOf(entry),
            TmdbId = tmdbId,
            TvdbId = 0,
            ItemKey = InventoryKeys.Movie(tmdbId),
            SeasonCount = 0,
            Genres = NamesOf(entry, genres),
            Rating = entry["vote_average"]?.GetValue<double?>(),
            Popularity = entry["popularity"]?.GetValue<double?>(),
        };
    }

    /// <summary>One show out of a discover response, once its TVDB id is known.</summary>
    /// <param name="entry">The provider's object.</param>
    /// <param name="tvdbId">The TVDB id every series item key is built from.</param>
    /// <param name="genres">Genre ids to names.</param>
    /// <returns>The result, or null when either id is missing.</returns>
    /// <remarks>
    /// A show with no TVDB id is dropped rather than emitted with a zero. Every series key in the
    /// system is <c>episode:tvdb:{id}:</c>, so a zero would be one key shared by every untranslated
    /// show in the catalogue: they would report each other's holders, each other's request state,
    /// and asking for one would look like asking for all of them.
    /// </remarks>
    public static RequestSearchResult? FromTmdbSeries(
        JsonObject? entry,
        int tvdbId,
        IReadOnlyDictionary<int, string> genres)
    {
        ArgumentNullException.ThrowIfNull(genres);
        var tmdbId = entry?["id"]?.GetValue<int?>() ?? 0;
        if (entry is null || tmdbId <= 0 || tvdbId <= 0)
        {
            return null;
        }

        return new RequestSearchResult
        {
            Kind = "series",
            Title = entry["name"]?.GetValue<string>() ?? string.Empty,
            Year = YearOf(entry["first_air_date"]?.GetValue<string>()),
            Overview = Blank(entry["overview"]?.GetValue<string>()),
            PosterUrl = PosterOf(entry),

            // Zero, deliberately, even though we have one. A request body carrying both ids is
            // read as a film by CreateAsync, which decides the kind from whichever id is set, so a
            // series that volunteered its TMDB id would be requested from the wrong manager. The
            // TMDB id has done its job by the time this is built: it is what the TVDB id was
            // translated from.
            TmdbId = 0,
            TvdbId = tvdbId,
            ItemKey = InventoryKeys.SeriesPrefix(tvdbId),

            // Zero here, and filled in by the caller: a discover entry carries no season count,
            // and the show's own record — which `SeriesFactsAsync` is already fetching for the
            // TVDB translation — does. This mapper stays pure so a test can hand it a page of
            // JSON and no network.
            SeasonCount = 0,
            Genres = NamesOf(entry, genres),
            Rating = entry["vote_average"]?.GetValue<double?>(),
            Popularity = entry["popularity"]?.GetValue<double?>(),
        };
    }

    /// <summary>
    /// The credits worth showing off a <c>combined_credits</c> body, ordered and capped.
    /// </summary>
    /// <param name="body">The provider's answer.</param>
    /// <param name="wantMovies">Films when true, shows when false.</param>
    /// <param name="limit">How many to keep.</param>
    /// <returns>The entries, most-watched first.</returns>
    /// <remarks>
    /// <para>
    /// <strong>Cast only, never crew.</strong> The surface is "what this person appears in"; folding
    /// in what they executive-produced turns a twelve-card row into a ninety-card one made mostly of
    /// titles their face is not in.
    /// </para>
    /// <para>
    /// <strong>Ordered by popularity, which is the one place this file sorts a provider answer.</strong>
    /// A feed and a related row both keep the provider's own order, because both have one worth
    /// keeping. <c>combined_credits</c> does not: it arrives roughly by the provider's internal id,
    /// which is neither chronological nor by prominence, so a working actor's one-episode talk-show
    /// appearances would open the row ahead of the films they are known for. Dan, 2026-09-12.
    /// </para>
    /// </remarks>
    public static List<JsonObject> CreditEntries(JsonNode? body, bool wantMovies, int limit)
    {
        var wanted = wantMovies ? "movie" : "tv";
        if (body?["cast"] is not JsonArray cast)
        {
            return new List<JsonObject>();
        }

        return cast
            .OfType<JsonObject>()
            .Where(entry => string.Equals(entry["media_type"]?.GetValue<string>(), wanted, StringComparison.Ordinal))

            // A person's credits are the one catalogue answer that is not already filtered for this.
            // `/discover` takes `include_adult=false` as a parameter; `combined_credits` has no such
            // knob and simply tells you, so the filtering happens here instead.
            .Where(entry => entry["adult"]?.GetValue<bool?>() != true)
            .OrderByDescending(entry => entry["popularity"]?.GetValue<double?>() ?? 0)
            .Take(Math.Max(limit, 0))
            .ToList();
    }

    /// <summary>
    /// Whether a person search result really is the person asked about.
    /// </summary>
    /// <param name="wantedName">The name off the library's own person item.</param>
    /// <param name="candidate">One of the provider's matches.</param>
    /// <returns>True only on an exact name, once both are normalised.</returns>
    /// <remarks>
    /// Deliberately strict, and this is the whole safety of the search fallback. Taking the
    /// provider's first match for a near miss attaches one actor's filmography to another actor's
    /// page — a failure that is invisible, entirely plausible on screen, and impossible for the
    /// reader to detect. A miss answers an empty row instead, which is honest.
    /// </remarks>
    public static bool MatchesPerson(string? wantedName, JsonObject? candidate)
    {
        var wanted = NormaliseName(wantedName);
        var got = NormaliseName(candidate?["name"]?.GetValue<string>());
        return wanted.Length > 0 && string.Equals(wanted, got, StringComparison.Ordinal);
    }

    /// <summary>Case, punctuation and spacing folded away, so two spellings of one name compare equal.</summary>
    private static string NormaliseName(string? value)
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

    /// <summary>The provider's sort parameter for one of ours.</summary>
    /// <param name="sort">Our sort name.</param>
    /// <param name="order"><c>asc</c>, or anything else for descending.</param>
    /// <param name="isMovie">Films and series name their release date differently.</param>
    /// <returns>The provider's <c>sort_by</c> value.</returns>
    public static string SortParam(string? sort, string? order, bool isMovie)
    {
        var direction = string.Equals(order, "asc", StringComparison.OrdinalIgnoreCase) ? "asc" : "desc";
        var field = (sort ?? string.Empty).ToLowerInvariant() switch
        {
            "top_rated" => "vote_average",
            "newest" => isMovie ? "primary_release_date" : "first_air_date",
            "title" => isMovie ? "title" : "name",
            _ => "popularity",
        };

        return field + "." + direction;
    }

    // --- fetching -----------------------------------------------------------

    /// <summary>
    /// What the provider's own audience went on to watch after this.
    /// </summary>
    /// <param name="isMovie">Whether the subject is a film.</param>
    /// <param name="tmdbId">The subject's TMDB id. A show's own id, never an episode's.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The titles, in the provider's own order. Empty when the catalogue could not be read.</returns>
    /// <remarks>
    /// <para>
    /// <c>/recommendations</c> rather than <c>/similar</c>. The two look interchangeable and are
    /// not: <c>/similar</c> is keyword and genre overlap, which in practice answers a well-known
    /// film with a page of direct-to-video titles sharing one tag. <c>/recommendations</c> is the
    /// collaborative "people who liked this also liked" list, which is what the provider's own site
    /// shows under that heading and what a person means by "related".
    /// </para>
    /// <para>
    /// The order is the provider's, untouched. Dan, 2026-09-12: a related row is ordered by
    /// relevance or it is not a related row, and the glyph on each card is what says whether the
    /// library holds it.
    /// </para>
    /// </remarks>
    public async Task<IReadOnlyList<RequestSearchResult>> RelatedAsync(
        bool isMovie,
        int tmdbId,
        CancellationToken cancellationToken)
    {
        if (tmdbId <= 0)
        {
            return Array.Empty<RequestSearchResult>();
        }

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(_passTimeout);

        try
        {
            var id = tmdbId.ToString(CultureInfo.InvariantCulture);
            var path = isMovie
                ? $"/movie/{id}/recommendations?page=1"
                : $"/tv/{id}/recommendations?page=1";

            var body = await GetAsync(path, _feedTtl, budget.Token).ConfigureAwait(false);
            if (body?["results"] is not JsonArray entries || entries.Count == 0)
            {
                return Array.Empty<RequestSearchResult>();
            }

            var genres = await GenresAsync(isMovie, budget.Token).ConfigureAwait(false);
            var results = isMovie
                ? await MoviesAsync(entries, genres, false, budget.Token).ConfigureAwait(false)
                : await SeriesAsync(entries, genres, budget.Token).ConfigureAwait(false);

            // The subject itself, belt and braces. The provider does not normally recommend a title
            // to itself, and the caller has already resolved the id, so dropping it here costs
            // nothing and stops the one case that would look obviously broken.
            var subjectKey = isMovie ? InventoryKeys.Movie(tmdbId) : null;
            return Dedupe(results)
                .Where(r => subjectKey is null || !string.Equals(r.ItemKey, subjectKey, StringComparison.Ordinal))
                .Take(RowLimit)
                .ToList();
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning("The catalogue did not answer about related titles inside {Budget}", _passTimeout);
            return Array.Empty<RequestSearchResult>();
        }
    }

    /// <summary>
    /// What a person appears in, most-watched first.
    /// </summary>
    /// <param name="tmdbPersonId">The provider's id for them.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The titles. Empty when the catalogue could not be read.</returns>
    /// <remarks>
    /// One call. <c>/combined_credits</c> answers films and shows in a single array tagged by
    /// <c>media_type</c>, so asking <c>/movie_credits</c> and <c>/tv_credits</c> separately would be
    /// two calls for the same answer. See <see cref="CreditEntries"/> for why this is the one
    /// catalogue answer that gets sorted.
    /// </remarks>
    public async Task<IReadOnlyList<RequestSearchResult>> CreditsAsync(
        int tmdbPersonId,
        CancellationToken cancellationToken)
    {
        if (tmdbPersonId <= 0)
        {
            return Array.Empty<RequestSearchResult>();
        }

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(_passTimeout);

        try
        {
            var id = tmdbPersonId.ToString(CultureInfo.InvariantCulture);
            var body = await GetAsync($"/person/{id}/combined_credits", _feedTtl, budget.Token)
                .ConfigureAwait(false);
            if (body is null)
            {
                return Array.Empty<RequestSearchResult>();
            }

            var films = CreditEntries(body, true, RowLimit);
            var shows = CreditEntries(body, false, RowLimit);

            var results = new List<RequestSearchResult>();
            if (films.Count > 0)
            {
                var genres = await GenresAsync(true, budget.Token).ConfigureAwait(false);
                results.AddRange(await MoviesAsync(ArrayOf(films), genres, false, budget.Token)
                    .ConfigureAwait(false));
            }

            if (shows.Count > 0)
            {
                var genres = await GenresAsync(false, budget.Token).ConfigureAwait(false);
                results.AddRange(await SeriesAsync(ArrayOf(shows), genres, budget.Token)
                    .ConfigureAwait(false));
            }

            // Re-sorted after the merge, not before: the two halves were each capped and ordered on
            // their own, and a row that ran every film before every show would read as two rows
            // wearing one heading.
            return Dedupe(results.OrderByDescending(r => r.Popularity ?? 0)).Take(RowLimit).ToList();
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning("The catalogue did not answer about credits inside {Budget}", _passTimeout);
            return Array.Empty<RequestSearchResult>();
        }
    }

    /// <summary>
    /// The provider's id for a person the library knows only by name.
    /// </summary>
    /// <param name="name">The name off the library's own person item.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The id, or null when nothing matched exactly.</returns>
    /// <remarks>
    /// <para>
    /// The fallback for a person item carrying no TMDB id, which is the ordinary state of every
    /// person on a library scanned before the metadata provider was turned on. Answering nothing
    /// there would make this feature quietly not work for exactly the library it is most use to.
    /// </para>
    /// <para>
    /// <strong>Not cached in <c>provider_id_map</c>, and that is not an oversight.</strong> Both of
    /// that table's ends are integers, and what we hold here is a name. Hashing one to an integer
    /// key would put a silent collision in the single place a collision attaches the wrong person's
    /// filmography to somebody's page. <see cref="GetAsync"/>'s own cache keys on the whole path
    /// string, so the search is already free after the first call within the TTL, for every user on
    /// this node. That is the right cache for this.
    /// </para>
    /// </remarks>
    public async Task<int?> PersonIdAsync(string? name, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        var body = await GetAsync(
                $"/search/person?query={Uri.EscapeDataString(name)}&include_adult=false",
                _genreTtl,
                cancellationToken)
            .ConfigureAwait(false);

        if (body?["results"] is not JsonArray results)
        {
            return null;
        }

        foreach (var candidate in results.OfType<JsonObject>())
        {
            if (!MatchesPerson(name, candidate))
            {
                continue;
            }

            var id = candidate["id"]?.GetValue<int?>() ?? 0;
            if (id > 0)
            {
                return id;
            }
        }

        return null;
    }

    /// <summary>
    /// The TMDB show id for a TVDB one, remembered either way.
    /// </summary>
    /// <param name="tvdbId">The id a series item key is built from.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The provider's own id for the show, or null.</returns>
    /// <remarks>
    /// The reverse of what <see cref="SeriesFactsAsync"/> caches, and it earns a
    /// <c>provider_id_map</c> row where a person id cannot: both ends are integers. The two
    /// directions are independent rows, since <c>TryCachedProviderId</c> matches on all three
    /// columns.
    /// </remarks>
    public async Task<int?> TmdbShowIdAsync(int tvdbId, CancellationToken cancellationToken)
    {
        if (tvdbId <= 0)
        {
            return null;
        }

        if (_store.TryCachedProviderId(TvdbProvider, tvdbId, TmdbProvider, out var cached))
        {
            return cached;
        }

        var id = tvdbId.ToString(CultureInfo.InvariantCulture);
        var body = await GetAsync($"/find/{id}?external_source=tvdb_id", _genreTtl, cancellationToken)
            .ConfigureAwait(false);

        var found = (body?["tv_results"] as JsonArray)?
            .OfType<JsonObject>()
            .Select(entry => entry["id"]?.GetValue<int?>() ?? 0)
            .FirstOrDefault(value => value > 0);

        // Remembered either way, the miss included: a show the provider cannot translate would
        // otherwise be asked about on every page load that mentions it.
        await _store.CacheProviderIdAsync(TvdbProvider, tvdbId, TmdbProvider, found, cancellationToken)
            .ConfigureAwait(false);

        return found is > 0 ? found : null;
    }

    /// <summary>The entries as the array the mapping passes take.</summary>
    private static JsonArray ArrayOf(IEnumerable<JsonObject> entries)
    {
        var array = new JsonArray();
        foreach (var entry in entries)
        {
            // Detached first: a node already parented to the response cannot be added to a second
            // array, and `combined_credits` hands us children of its own `cast`.
            array.Add(entry.DeepClone());
        }

        return array;
    }

    private async Task<List<RequestSearchResult>> PageAsync(
        TmdbBrowseQuery query,
        bool isMovie,
        CancellationToken cancellationToken)
    {
        var genres = await GenresAsync(isMovie, cancellationToken).ConfigureAwait(false);
        var wanted = GenreIds(query.Genres, genres);
        if (query.Genres.Count > 0 && wanted.Count == 0)
        {
            // The reader asked for a genre this kind does not have: "Sci-Fi & Fantasy" is a series
            // genre with no film equivalent. Answering with an unfiltered feed would be worse than
            // answering with nothing, because it would look like the filter had not worked.
            return new List<RequestSearchResult>();
        }

        var results = new List<RequestSearchResult>();
        var first = ((Math.Max(query.Page, 1) - 1) * PagesPerFeed) + 1;
        for (var page = first; page < first + PagesPerFeed; page++)
        {
            var body = await GetAsync(FeedPath(query, isMovie, wanted, page), _feedTtl, cancellationToken)
                .ConfigureAwait(false);
            if (body?["results"] is not JsonArray entries || entries.Count == 0)
            {
                break;
            }

            results.AddRange(isMovie
                ? await MoviesAsync(entries, genres, true, cancellationToken).ConfigureAwait(false)
                : await SeriesAsync(entries, genres, cancellationToken).ConfigureAwait(false));
        }

        return results;
    }

    /// <summary>Turn a page of films into results, with each one's IMDb id.</summary>
    /// <param name="entries">The provider's objects.</param>
    /// <param name="genres">Genre ids to names.</param>
    /// <param name="withImdb">Whether to spend a call per film on its IMDb id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The results, in the order the provider gave them.</returns>
    /// <remarks>
    /// <paramref name="withImdb"/> is false for the related and credits rows, and that is a
    /// deliberate saving rather than an oversight. The IMDb id buys exactly one thing: the score on
    /// a title becomes a link out to the page it came from, and that link is only ever drawn
    /// <em>inside <c>RequestSheet</c></em> (<c>docs/REQUESTS.md</c> §9, "The score is a way out to
    /// IMDb, from the sheet only"), where <c>imdbUrl</c> already falls back to an IMDb search on the
    /// title when there is no id. A detail page opens up to four of these rows at once, so paying
    /// twenty cold calls each to decorate something unreachable from the row is the wrong trade.
    /// The feed still pays it, because a feed is the one place somebody is reading scores to choose.
    /// </remarks>
    private async Task<List<RequestSearchResult>> MoviesAsync(
        JsonArray entries,
        IReadOnlyDictionary<int, string> genres,
        bool withImdb,
        CancellationToken cancellationToken)
    {
        using var slots = new SemaphoreSlim(IdConcurrency);
        var work = entries
            .OfType<JsonObject>()
            .Select(async entry =>
            {
                var result = FromTmdbMovie(entry, genres);
                if (result is null)
                {
                    return null;
                }

                if (!withImdb)
                {
                    return result;
                }

                await slots.WaitAsync(cancellationToken).ConfigureAwait(false);
                try
                {
                    result.ImdbId = await MovieImdbIdAsync(result.TmdbId, cancellationToken)
                        .ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // The budget ran out while enriching. The title is still a good result — it
                    // simply loses the link out to IMDb, which the app already falls back to a
                    // search for. Dropping the whole feed over a decoration would be the worse
                    // trade by a distance.
                }
                finally
                {
                    slots.Release();
                }

                return result;
            });

        return Mapped(await Task.WhenAll(work).ConfigureAwait(false));
    }

    /// <summary>Turn a page of shows into results, translating each one's id.</summary>
    private async Task<List<RequestSearchResult>> SeriesAsync(
        JsonArray entries,
        IReadOnlyDictionary<int, string> genres,
        CancellationToken cancellationToken)
    {
        using var slots = new SemaphoreSlim(IdConcurrency);
        var work = entries
            .OfType<JsonObject>()
            .Select(async entry =>
            {
                await slots.WaitAsync(cancellationToken).ConfigureAwait(false);
                try
                {
                    var tmdbId = entry["id"]?.GetValue<int?>() ?? 0;
                    var facts = await SeriesFactsAsync(tmdbId, cancellationToken).ConfigureAwait(false);
                    var result = FromTmdbSeries(entry, facts.TvdbId ?? 0, genres);
                    if (result is not null)
                    {
                        result.ImdbId = facts.ImdbId;
                        result.SeasonCount = facts.Seasons;
                    }

                    return result;
                }
                finally
                {
                    slots.Release();
                }
            });

        return Mapped(await Task.WhenAll(work).ConfigureAwait(false));
    }

    /// <summary>The non-null results of a page, in the order the provider gave them.</summary>
    private static List<RequestSearchResult> Mapped(RequestSearchResult?[] mapped)
    {
        var results = new List<RequestSearchResult>();
        foreach (var result in mapped)
        {
            if (result is not null)
            {
                results.Add(result);
            }
        }

        return results;
    }

    /// <summary>What one call about a show answers: its two ids and how long it is.</summary>
    /// <param name="TvdbId">The id every series item key is built from, or null for a miss.</param>
    /// <param name="ImdbId">The IMDb id, or null when the provider knows none.</param>
    /// <param name="Seasons">Seasons, specials excluded, or 0 when the provider did not say.</param>
    private readonly record struct SeriesFacts(int? TvdbId, string? ImdbId, int Seasons);

    /// <summary>
    /// The ids and season count for a TMDB series id, remembered either way.
    /// </summary>
    /// <remarks>
    /// One call, not three. This used to ask <c>/external_ids</c> for the TVDB id alone; the show's
    /// own record carries the same block under <c>append_to_response</c> plus the season count, so
    /// the extra two facts cost nothing but a slightly larger body. All three are cached
    /// separately, and any one of them being stale re-asks for all three, which is what keeps a
    /// show's season count from being pinned to whatever it was the first time anybody scrolled
    /// past it.
    /// </remarks>
    private async Task<SeriesFacts> SeriesFactsAsync(int tmdbId, CancellationToken cancellationToken)
    {
        if (tmdbId <= 0)
        {
            return default;
        }

        if (_store.TryCachedProviderId(TmdbProvider, tmdbId, TvdbProvider, out var tvdbCached)
            && _store.TryCachedProviderId(TmdbProvider, tmdbId, ImdbProvider, out var imdbCached)
            && _store.TryCachedProviderId(TmdbProvider, tmdbId, SeasonsKey, out var seasonsCached))
        {
            return new SeriesFacts(tvdbCached, ImdbTag(imdbCached), seasonsCached ?? 0);
        }

        var body = await GetAsync(
                $"/tv/{tmdbId.ToString(CultureInfo.InvariantCulture)}?append_to_response=external_ids",
                _genreTtl,
                cancellationToken)
            .ConfigureAwait(false);

        var external = body?["external_ids"];
        var tvdbId = external?["tvdb_id"]?.GetValue<int?>();
        if (tvdbId is <= 0)
        {
            tvdbId = null;
        }

        var imdbId = Blank(external?["imdb_id"]?.GetValue<string>());
        var seasons = body?["number_of_seasons"]?.GetValue<int?>() ?? 0;

        // Remembered either way. The miss is the more valuable of the two: a show the provider knows
        // no TVDB id for would otherwise be asked about on every single page load.
        await _store.CacheProviderIdAsync(TmdbProvider, tmdbId, TvdbProvider, tvdbId, cancellationToken)
            .ConfigureAwait(false);
        await _store.CacheProviderIdAsync(TmdbProvider, tmdbId, ImdbProvider, ImdbNumber(imdbId), cancellationToken)
            .ConfigureAwait(false);
        await _store.CacheProviderIdAsync(
                TmdbProvider,
                tmdbId,
                SeasonsKey,
                seasons > 0 ? seasons : null,
                cancellationToken)
            .ConfigureAwait(false);

        return new SeriesFacts(tvdbId, imdbId, seasons);
    }

    /// <summary>The IMDb id for a TMDB film id, remembered either way.</summary>
    /// <remarks>
    /// A discover response carries no IMDb id, so this is one call per film the first time the
    /// catalogue meets it and nothing at all afterwards — the same deal the series half has always
    /// made for its TVDB translation, and the same cache. It buys the one thing a poster cannot
    /// do, which is take somebody to the page the score came from.
    /// </remarks>
    private async Task<string?> MovieImdbIdAsync(int tmdbId, CancellationToken cancellationToken)
    {
        if (tmdbId <= 0)
        {
            return null;
        }

        if (_store.TryCachedProviderId(TmdbProvider, tmdbId, ImdbProvider, out var cached))
        {
            return ImdbTag(cached);
        }

        var body = await GetAsync(
                $"/movie/{tmdbId.ToString(CultureInfo.InvariantCulture)}/external_ids",
                _genreTtl,
                cancellationToken)
            .ConfigureAwait(false);

        var imdbId = Blank(body?["imdb_id"]?.GetValue<string>());
        await _store.CacheProviderIdAsync(TmdbProvider, tmdbId, ImdbProvider, ImdbNumber(imdbId), cancellationToken)
            .ConfigureAwait(false);
        return imdbId;
    }

    /// <summary>The digits of an IMDb id, for the integer column it caches in.</summary>
    /// <param name="tag">An id like <c>tt0063951</c>, or null.</param>
    /// <returns>The number, or null when there is no id to remember.</returns>
    private static int? ImdbNumber(string? tag)
    {
        if (string.IsNullOrWhiteSpace(tag))
        {
            return null;
        }

        var digits = tag.AsSpan().TrimStart('t');
        return int.TryParse(digits, NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value > 0
            ? value
            : null;
    }

    /// <summary>The IMDb id a cached number stands for.</summary>
    /// <param name="number">The number remembered, or null for a remembered miss.</param>
    /// <returns><c>tt</c> and at least seven digits, or null.</returns>
    /// <remarks>
    /// Seven digits is the shortest IMDb writes, and an id long enough to need eight keeps them:
    /// <c>D7</c> pads, it does not truncate.
    /// </remarks>
    private static string? ImdbTag(int? number)
        => number is > 0
            ? "tt" + number.Value.ToString("D7", CultureInfo.InvariantCulture)
            : null;

    /// <summary>The provider's genre table for one kind, as ids to names.</summary>
    private async Task<IReadOnlyDictionary<int, string>> GenresAsync(bool isMovie, CancellationToken cancellationToken)
    {
        var body = await GetAsync(isMovie ? "/genre/movie/list" : "/genre/tv/list", _genreTtl, cancellationToken)
            .ConfigureAwait(false);

        var map = new Dictionary<int, string>();
        if (body?["genres"] is not JsonArray genres)
        {
            return map;
        }

        foreach (var genre in genres.OfType<JsonObject>())
        {
            var id = genre["id"]?.GetValue<int?>() ?? 0;
            var name = genre["name"]?.GetValue<string>();
            if (id > 0 && !string.IsNullOrWhiteSpace(name))
            {
                map[id] = name;
            }
        }

        return map;
    }

    /// <summary>
    /// The provider path one page of a feed comes from.
    /// </summary>
    /// <param name="query">What the screen asked for.</param>
    /// <param name="isMovie">Films or series.</param>
    /// <param name="genreIds">The provider's ids for the genre names chosen, already resolved.</param>
    /// <param name="page">One-based.</param>
    /// <returns>The path and query string, without the key.</returns>
    /// <remarks>
    /// <para>
    /// One query shape for every feed, deliberately. Their own <c>top_rated</c> endpoint was the
    /// obvious way to answer "the best ever made" and is not one: it is the same raw average at a
    /// low vote threshold, it opened with the same unrecognisable titles from this year, and it
    /// accepts neither a genre nor a year, so it would have answered only the unnarrowed case
    /// anyway. The floor is what makes that list right, and it belongs on every path to it.
    /// </para>
    /// <para>
    /// Public and static so the query it builds can be pinned by a test. Every choice in here is
    /// invisible in the result: a bad floor looks exactly like a good one, it is just the wrong
    /// films.
    /// </para>
    /// </remarks>
    public static string FeedPath(
        TmdbBrowseQuery query,
        bool isMovie,
        IReadOnlyList<int> genreIds,
        int page)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentNullException.ThrowIfNull(genreIds);

        var pageParam = "page=" + page.ToString(CultureInfo.InvariantCulture);
        var allTime = string.Equals(query.Sort, "top_rated", StringComparison.OrdinalIgnoreCase);
        var path = isMovie ? "/discover/movie" : "/discover/tv";
        var parts = new List<string>
        {
            "include_adult=false",
            "language=en-US",
            "sort_by=" + SortParam(query.Sort, query.Order, isMovie),
            pageParam,
        };

        // Both directions need the rating floor, not just the default one: ascending by rating
        // without it is the same nine-vote curiosities from the other end.
        if (allTime)
        {
            parts.Add("vote_count.gte="
                + (isMovie ? MovieVoteFloor : SeriesVoteFloor).ToString(CultureInfo.InvariantCulture));
        }
        else if (!string.IsNullOrEmpty(query.Sort)
                 && !string.Equals(query.Sort, "popular", StringComparison.OrdinalIgnoreCase))
        {
            // Popularity needs no floor of its own: it is already a measure of how many people are
            // looking at something.
            parts.Add("vote_count.gte=" + ObscurityFloor.ToString(CultureInfo.InvariantCulture));
        }

        if (genreIds.Count > 0)
        {
            parts.Add("with_genres=" + string.Join(
                ",",
                genreIds.Select(id => id.ToString(CultureInfo.InvariantCulture))));
        }

        if (query.Year is > 0)
        {
            var year = query.Year.Value.ToString(CultureInfo.InvariantCulture);
            parts.Add(isMovie ? "primary_release_year=" + year : "first_air_date_year=" + year);
        }

        return path + "?" + string.Join("&", parts);
    }

    /// <summary>
    /// One GET against the metadata provider, cached, with every failure flattened to null.
    /// </summary>
    /// <remarks>
    /// The cache is what keeps this node polite. The key ships with the server and is therefore
    /// shared across every install of it, so a feed that refetched on every chip press would be
    /// this node's contribution to somebody else's rate limit.
    /// </remarks>
    private async Task<JsonNode?> GetAsync(string path, TimeSpan ttl, CancellationToken cancellationToken)
    {
        if (_cache.TryGetValue(path, out var cached) && DateTime.UtcNow - cached.At <= ttl)
        {
            return cached.Body;
        }

        var key = ApiKey;
        if (string.IsNullOrWhiteSpace(key))
        {
            return null;
        }

        var separator = path.Contains('?', StringComparison.Ordinal) ? "&" : "?";
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_callTimeout);
        try
        {
            using var http = _httpFactory.CreateClient(HttpClientName);
            using var response = await http
                .GetAsync(BaseUrl + path + separator + "api_key=" + key, timeout.Token)
                .ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogDebug("The catalogue answered {Status} for {Path}", (int)response.StatusCode, path);
                return Stale(path);
            }

            var body = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
            var parsed = string.IsNullOrWhiteSpace(body) ? null : JsonNode.Parse(body);
            if (parsed is not null)
            {
                _cache[path] = (DateTime.UtcNow, parsed);
            }

            return parsed;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or OperationCanceledException)
        {
            _logger.LogDebug(ex, "The catalogue did not answer for {Path}", path);
            return Stale(path);
        }
    }

    /// <summary>
    /// The expired copy of a page, when the provider will not give a fresh one.
    /// </summary>
    /// <remarks>
    /// Yesterday's popular list is a good screen. An empty grid, after the reader has already seen
    /// a full one, is a broken screen.
    /// </remarks>
    private JsonNode? Stale(string path)
        => _cache.TryGetValue(path, out var cached) ? cached.Body : null;

    // --- helpers ------------------------------------------------------------

    /// <summary>The configured key, or the one the server ships for its own metadata.</summary>
    private static string ApiKey
    {
        get
        {
            var configured = Plugin.Instance?.Configuration?.TmdbApiKey;
            return string.IsNullOrWhiteSpace(configured) ? TmdbUtils.ApiKey : configured;
        }
    }

    private static List<int> GenreIds(IReadOnlyList<string> names, IReadOnlyDictionary<int, string> genres)
        => genres
            .Where(g => names.Any(name => string.Equals(name, g.Value, StringComparison.OrdinalIgnoreCase)))
            .Select(g => g.Key)
            .ToList();

    private static List<string> NamesOf(JsonObject entry, IReadOnlyDictionary<int, string> genres)
    {
        var names = new List<string>();
        if (entry["genre_ids"] is not JsonArray ids)
        {
            return names;
        }

        foreach (var id in ids)
        {
            if (id?.GetValue<int?>() is int value && genres.TryGetValue(value, out var name))
            {
                names.Add(name);
            }
        }

        return names;
    }

    private static List<RequestSearchResult> Order(List<RequestSearchResult> results, TmdbBrowseQuery query)
    {
        var ascending = string.Equals(query.Order, "asc", StringComparison.OrdinalIgnoreCase);
        IEnumerable<RequestSearchResult> ordered = (query.Sort ?? string.Empty).ToLowerInvariant() switch
        {
            "top_rated" => results.OrderByDescending(r => r.Rating ?? 0),
            "newest" => results.OrderByDescending(r => r.Year ?? 0),
            "title" => results.OrderByDescending(r => r.Title, StringComparer.OrdinalIgnoreCase),
            _ => results.OrderByDescending(r => r.Popularity ?? 0),
        };

        return ascending ? ordered.Reverse().ToList() : ordered.ToList();
    }

    private static List<RequestSearchResult> Dedupe(IEnumerable<RequestSearchResult> results)
    {
        // The provider's popular list shifts between one page fetch and the next, so the same title
        // arriving twice is expected rather than a fault.
        var seen = new HashSet<string>(StringComparer.Ordinal);
        return results.Where(r => seen.Add(r.ItemKey)).ToList();
    }

    private static int? YearOf(string? date)
        => date is { Length: >= 4 } && int.TryParse(
            date.AsSpan(0, 4),
            NumberStyles.Integer,
            CultureInfo.InvariantCulture,
            out var year)
            ? year
            : null;

    private static string? PosterOf(JsonObject entry)
    {
        var path = entry["poster_path"]?.GetValue<string>();
        return string.IsNullOrWhiteSpace(path) ? null : PosterBase + path;
    }

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;
}

/// <summary>What the Find screen is asking the catalogue for.</summary>
public sealed class TmdbBrowseQuery
{
    /// <summary><c>movie</c>, <c>series</c>, or anything else for both.</summary>
    public string? Kind { get; set; }

    /// <summary><c>popular</c>, <c>top_rated</c>, <c>newest</c> or <c>title</c>.</summary>
    public string? Sort { get; set; }

    /// <summary><c>asc</c> or <c>desc</c>.</summary>
    public string? Order { get; set; }

    /// <summary>Genre names, as the screen's own chip shows them.</summary>
    public IReadOnlyList<string> Genres { get; set; } = Array.Empty<string>();

    /// <summary>A release year, or null for every year.</summary>
    public int? Year { get; set; }

    /// <summary>Which sixty. One-based.</summary>
    public int Page { get; set; } = 1;
}
