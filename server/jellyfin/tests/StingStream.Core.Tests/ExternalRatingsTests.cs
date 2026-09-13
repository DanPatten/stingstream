using System.Text.Json.Nodes;
using StingStream.Core.Requests;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Reading IMDb's and Rotten Tomatoes' answers into the scores the Requests screen draws.
/// </summary>
/// <remarks>
/// The matching is what matters. A wrong Rotten Tomatoes score on a card looks exactly like a right
/// one, so the cases here are the near misses: a remake, a subtitle, a title with no year to check.
/// </remarks>
public sealed class ExternalRatingsTests
{
    [Fact]
    public void ReadsEveryImdbScoreInABatch()
    {
        var body = JsonNode.Parse(
            """
            {"data":{"titles":[
              {"id":"tt0133093","ratingsSummary":{"aggregateRating":8.7,"voteCount":2277311}},
              {"id":"tt11126994","ratingsSummary":{"aggregateRating":9,"voteCount":456378}},
              {"id":"tt9999999999","ratingsSummary":{"aggregateRating":null,"voteCount":0}}
            ]}}
            """);

        var scores = ExternalRatings.ImdbScoresFrom(body);

        Assert.NotNull(scores);
        Assert.Equal(8.7, scores!["tt0133093"].Rating);
        Assert.Equal(2277311, scores["tt0133093"].Votes);
        Assert.Equal(9, scores["tt11126994"].Rating);
        Assert.Null(scores["tt9999999999"].Rating);
        Assert.Null(scores["tt9999999999"].Votes);
    }

    /// <summary>An error is not "nobody rated these", and must not be remembered as that.</summary>
    [Fact]
    public void AnImdbErrorIsNoAnswer()
    {
        Assert.Null(ExternalRatings.ImdbScoresFrom(JsonNode.Parse("""{"errors":[{"message":"no"}]}""")));
        Assert.Null(ExternalRatings.ImdbScoresFrom(null));
    }

    [Theory]
    [InlineData("tt0133093", "tt0133093")]
    [InlineData(" tt11126994 ", "tt11126994")]
    [InlineData("tt123", null)]
    [InlineData("nm0000206", null)]
    [InlineData("tt0133093\"}", null)]
    [InlineData(null, null)]
    public void OnlyARealImdbIdGoesUpstream(string? given, string? expected)
        => Assert.Equal(expected, ExternalRatings.ImdbIdOrNull(given));

    [Fact]
    public void PicksTheFilmFromTheRightYear()
    {
        var result = Hits(
            """{"title":"The Matrix Resurrections","releaseYear":2021,"vanity":"the_matrix_resurrections","rottenTomatoes":{"criticsScore":63,"audienceScore":63}}""",
            """{"title":"The Matrix","releaseYear":1999,"vanity":"matrix","rottenTomatoes":{"criticsScore":83,"audienceScore":85}}""");

        var score = ExternalRatings.RottenTomatoesFrom(result, true, "The Matrix", 1999);

        Assert.NotNull(score);
        Assert.Equal(83, score!.Value.Critics);
        Assert.Equal(85, score.Value.Audience);
        Assert.Equal("https://www.rottentomatoes.com/m/matrix", score.Value.Url);
    }

    [Fact]
    public void RefusesARemake()
    {
        var result = Hits("""{"title":"Dune","releaseYear":1984,"vanity":"dune","rottenTomatoes":{"criticsScore":36}}""");

        Assert.Null(ExternalRatings.RottenTomatoesFrom(result, true, "Dune", 2021));
    }

    /// <summary>Release dates differ by a year between countries, and that is the same film.</summary>
    [Fact]
    public void ToleratesAYearEitherWay()
    {
        var result = Hits("""{"title":"Parasite","releaseYear":2019,"vanity":"parasite_2019","rottenTomatoes":{"criticsScore":99}}""");

        Assert.Equal(99, ExternalRatings.RottenTomatoesFrom(result, true, "Parasite", 2020)!.Value.Critics);
    }

    [Fact]
    public void MatchesAShowListedWithASubtitle()
    {
        var result = Hits(
            """{"title":"Nick Arcade","releaseYear":1992,"vanity":"nick_arcade"}""",
            """{"title":"Arcane: League of Legends","releaseYear":2021,"vanity":"arcane_league_of_legends","rottenTomatoes":{"criticsScore":100,"audienceScore":87}}""");

        var score = ExternalRatings.RottenTomatoesFrom(result, false, "Arcane", 2021);

        Assert.NotNull(score);
        Assert.Equal(100, score!.Value.Critics);
        Assert.Equal("https://www.rottentomatoes.com/tv/arcane_league_of_legends", score.Value.Url);
    }

    /// <summary>Without a year to check, a subtitle match is a guess, and "Alien" is not "Alien Nation".</summary>
    [Fact]
    public void ASubtitleMatchNeedsTheYear()
    {
        var result = Hits("""{"title":"Alien Nation","releaseYear":1988,"vanity":"alien_nation"}""");

        Assert.Null(ExternalRatings.RottenTomatoesFrom(result, true, "Alien", null));
    }

    [Fact]
    public void MatchesAnAlternativeTitle()
    {
        var result = Hits("""{"title":"Léon: The Professional","aka":["Leon"],"releaseYear":1994,"vanity":"leon_the_professional","rottenTomatoes":{"criticsScore":73}}""");

        Assert.Equal(73, ExternalRatings.RottenTomatoesFrom(result, true, "Léon", 1994)!.Value.Critics);
    }

    /// <summary>A page with no critics' score yet is still the right page to link to.</summary>
    [Fact]
    public void AnUnscoredMatchKeepsItsPage()
    {
        var result = Hits("""{"title":"Sintel","releaseYear":2010,"vanity":"sintel"}""");

        var score = ExternalRatings.RottenTomatoesFrom(result, true, "Sintel", 2010);

        Assert.NotNull(score);
        Assert.Null(score!.Value.Critics);
        Assert.Equal("https://www.rottentomatoes.com/m/sintel", score.Value.Url);
    }

    private static JsonNode? Hits(params string[] hits)
        => JsonNode.Parse("{\"hits\":[" + string.Join(",", hits) + "]}");
}
