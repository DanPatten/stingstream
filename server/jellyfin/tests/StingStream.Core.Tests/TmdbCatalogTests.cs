using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using StingStream.Core.Requests;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Turning the metadata provider's answers into the results the Find screen draws.
/// </summary>
/// <remarks>
/// Mapping only, and deliberately: everything asserted here is a shape the provider hands over and
/// a decision we make about it, neither of which needs a network to check. The two that matter most
/// are the ones a screenshot would never catch. A show with no TVDB id must be dropped rather than
/// carried with a zero, because every series item key is built from that id and a shared zero would
/// make untranslated shows report each other's holders. And a title with no poster must come back
/// with none, rather than with a URL ending in the word "null" that resolves to a broken image.
/// </remarks>
public sealed class TmdbCatalogTests
{
    private static readonly Dictionary<int, string> _genres = new()
    {
        [28] = "Action",
        [18] = "Drama",
        [10765] = "Sci-Fi & Fantasy",
    };

    [Fact]
    public void MapsAFilm()
    {
        var result = TmdbCatalog.FromTmdbMovie(Movie(), _genres);

        Assert.NotNull(result);
        Assert.Equal("movie", result!.Kind);
        Assert.Equal("Blade Runner", result.Title);
        Assert.Equal(1982, result.Year);
        Assert.Equal(78, result.TmdbId);
        Assert.Equal(0, result.TvdbId);
        Assert.Equal("movie:tmdb:78", result.ItemKey);
        Assert.Equal("https://image.tmdb.org/t/p/w500/poster.jpg", result.PosterUrl);
        Assert.Equal(new[] { "Action", "Drama" }, result.Genres);
        Assert.Equal(8.1, result.Rating);
        Assert.Equal(42.5, result.Popularity);
    }

    [Fact]
    public void MapsAShowOntoItsTvdbId()
    {
        var result = TmdbCatalog.FromTmdbSeries(Series(), 121361, _genres);

        Assert.NotNull(result);
        Assert.Equal("series", result!.Kind);
        Assert.Equal("Game of Thrones", result.Title);
        Assert.Equal(2011, result.Year);
        Assert.Equal(121361, result.TvdbId);
        Assert.Equal("episode:tvdb:121361:", result.ItemKey);
        Assert.Equal(new[] { "Sci-Fi & Fantasy" }, result.Genres);
    }

    /// <summary>
    /// A series must never volunteer its TMDB id, however well known it is.
    /// </summary>
    /// <remarks>
    /// <c>RequestService.CreateAsync</c> decides the kind from whichever id the body carries, so a
    /// series result carrying both would be requested from the film manager.
    /// </remarks>
    [Fact]
    public void AShowCarriesNoTmdbId()
    {
        var result = TmdbCatalog.FromTmdbSeries(Series(), 121361, _genres);

        Assert.Equal(0, result!.TmdbId);
    }

    [Fact]
    public void DropsAShowWithNoTvdbId()
    {
        Assert.Null(TmdbCatalog.FromTmdbSeries(Series(), 0, _genres));
    }

    [Fact]
    public void DropsAnythingWithNoProviderId()
    {
        var nameless = new JsonObject { ["title"] = "Untitled" };

        Assert.Null(TmdbCatalog.FromTmdbMovie(nameless, _genres));
        Assert.Null(TmdbCatalog.FromTmdbMovie(null, _genres));
    }

    [Fact]
    public void NoPosterMeansNoPosterUrl()
    {
        var entry = Movie();
        entry.Remove("poster_path");

        Assert.Null(TmdbCatalog.FromTmdbMovie(entry, _genres)!.PosterUrl);
    }

    [Fact]
    public void AnUnknownGenreIdIsSkippedRatherThanNamed()
    {
        var entry = Movie();
        entry["genre_ids"] = new JsonArray(28, 99999);

        Assert.Equal(new[] { "Action" }, TmdbCatalog.FromTmdbMovie(entry, _genres)!.Genres);
    }

    [Fact]
    public void AMalformedDateLeavesTheYearEmpty()
    {
        var entry = Movie();
        entry["release_date"] = string.Empty;

        Assert.Null(TmdbCatalog.FromTmdbMovie(entry, _genres)!.Year);
    }

    [Theory]
    [InlineData(null, "desc", true, "popularity.desc")]
    [InlineData("popular", "desc", true, "popularity.desc")]
    [InlineData("top_rated", "desc", true, "vote_average.desc")]
    [InlineData("top_rated", "asc", true, "vote_average.asc")]
    [InlineData("newest", "desc", true, "primary_release_date.desc")]
    [InlineData("newest", "desc", false, "first_air_date.desc")]
    [InlineData("title", "desc", true, "title.desc")]
    [InlineData("title", "desc", false, "name.desc")]
    [InlineData("nonsense", "desc", true, "popularity.desc")]
    public void SortsMapOntoTheProvidersVocabulary(string? sort, string order, bool isMovie, string expected)
    {
        Assert.Equal(expected, TmdbCatalog.SortParam(sort, order, isMovie));
    }

    /// <summary>
    /// "The best ever made" is a vote floor, and the floor is the whole feature.
    /// </summary>
    /// <remarks>
    /// Measured against the live provider rather than reasoned about. Ordering by rating at a floor
    /// of 1000 votes opened with two films from the current year ahead of <em>The Shawshank
    /// Redemption</em>; at 5000 the list is Shawshank, <em>The Godfather</em> and <em>12 Angry
    /// Men</em>. Their own top-rated endpoint was tried first and is the same raw average at a low
    /// threshold, opening with the same unknowns, which is why every path to an all-time list goes
    /// through the floor instead.
    /// </remarks>
    [Fact]
    public void AnAllTimeListIsHeldToAMeasuredVoteFloor()
    {
        var films = TmdbCatalog.FeedPath(
            new TmdbBrowseQuery { Sort = "top_rated" },
            true,
            Array.Empty<int>(),
            1);

        Assert.StartsWith("/discover/movie?", films, StringComparison.Ordinal);
        Assert.Contains("sort_by=vote_average.desc", films, StringComparison.Ordinal);
        Assert.Contains("vote_count.gte=5000", films, StringComparison.Ordinal);

        var series = TmdbCatalog.FeedPath(
            new TmdbBrowseQuery { Sort = "top_rated" },
            false,
            Array.Empty<int>(),
            1);

        Assert.StartsWith("/discover/tv?", series, StringComparison.Ordinal);
        Assert.Contains("vote_count.gte=1000", series, StringComparison.Ordinal);
    }

    /// <summary>The floor holds from the other end too, and narrowing does not lift it.</summary>
    [Fact]
    public void TheFloorSurvivesBothAFilterAndAReversal()
    {
        var narrowed = TmdbCatalog.FeedPath(
            new TmdbBrowseQuery { Sort = "top_rated", Year = 1999 },
            true,
            new[] { 27 },
            1);

        Assert.Contains("vote_count.gte=5000", narrowed, StringComparison.Ordinal);
        Assert.Contains("with_genres=27", narrowed, StringComparison.Ordinal);
        Assert.Contains("primary_release_year=1999", narrowed, StringComparison.Ordinal);

        // Ascending by rating without the floor is the same nine-vote curiosities from the other
        // end, so it is not an exception.
        var worst = TmdbCatalog.FeedPath(
            new TmdbBrowseQuery { Sort = "top_rated", Order = "asc" },
            true,
            Array.Empty<int>(),
            1);

        Assert.Contains("sort_by=vote_average.asc", worst, StringComparison.Ordinal);
        Assert.Contains("vote_count.gte=5000", worst, StringComparison.Ordinal);
    }

    /// <summary>
    /// Release date and title carry a small floor; popularity carries none.
    /// </summary>
    /// <remarks>
    /// Ordering the whole catalogue by release date without one answers with festival documentaries
    /// nobody has voted on: a true answer to the query and a useless screen. Popularity is already
    /// a measure of how many people are looking, so a floor under it would be a second opinion
    /// about the same thing.
    /// </remarks>
    [Fact]
    public void OnlyTheOrdersThatNeedAFloorCarryOne()
    {
        var newest = TmdbCatalog.FeedPath(
            new TmdbBrowseQuery { Sort = "newest" },
            true,
            Array.Empty<int>(),
            1);
        Assert.Contains("vote_count.gte=50", newest, StringComparison.Ordinal);

        var popular = TmdbCatalog.FeedPath(
            new TmdbBrowseQuery { Sort = "popular" },
            true,
            Array.Empty<int>(),
            1);
        Assert.DoesNotContain("vote_count.gte", popular, StringComparison.Ordinal);

        var byDefault = TmdbCatalog.FeedPath(new TmdbBrowseQuery(), true, Array.Empty<int>(), 1);
        Assert.DoesNotContain("vote_count.gte", byDefault, StringComparison.Ordinal);
        Assert.Contains("sort_by=popularity.desc", byDefault, StringComparison.Ordinal);
        Assert.Contains("page=1", byDefault, StringComparison.Ordinal);
    }

    /// <summary>A family server's landing page, so this is not negotiable.</summary>
    [Fact]
    public void EveryQueryExcludesAdultTitles()
    {
        Assert.Contains(
            "include_adult=false",
            TmdbCatalog.FeedPath(new TmdbBrowseQuery(), true, Array.Empty<int>(), 1),
            StringComparison.Ordinal);
    }

    private static JsonObject Movie() => new()
    {
        ["id"] = 78,
        ["title"] = "Blade Runner",
        ["overview"] = "A blade runner must pursue and terminate four replicants.",
        ["poster_path"] = "/poster.jpg",
        ["release_date"] = "1982-06-25",
        ["vote_average"] = 8.1,
        ["popularity"] = 42.5,
        ["genre_ids"] = new JsonArray(28, 18),
    };

    private static JsonObject Series() => new()
    {
        ["id"] = 1399,
        ["name"] = "Game of Thrones",
        ["overview"] = "Seven noble families fight for control of the mythical land of Westeros.",
        ["poster_path"] = "/got.jpg",
        ["first_air_date"] = "2011-04-17",
        ["vote_average"] = 8.4,
        ["popularity"] = 310.0,
        ["genre_ids"] = new JsonArray(10765),
    };
}
