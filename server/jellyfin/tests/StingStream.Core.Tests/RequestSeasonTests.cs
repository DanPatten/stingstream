using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
using StingStream.Core.Requests;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The season picker, on both sides: what gets ticked in Sonarr, and what counts as "arrived".
/// </summary>
/// <remarks>
/// These two are a matched pair and are wrong in the same way if either is wrong on its own. Ticking
/// the wrong seasons downloads a show nobody asked for; reading the wrong season out of an item key
/// tells a requester their season 2 is ready when what landed was season 1.
/// </remarks>
public class RequestSeasonTests
{
    private static JsonObject Series(params int[] seasons)
    {
        var list = new JsonArray();
        foreach (var n in seasons)
        {
            list.Add(new JsonObject { ["seasonNumber"] = n, ["monitored"] = false });
        }

        return new JsonObject { ["seasons"] = list };
    }

    private static IReadOnlyList<int> Monitored(JsonObject series)
        => series["seasons"]!.AsArray()
            .OfType<JsonObject>()
            .Where(s => s["monitored"]!.GetValue<bool>())
            .Select(s => s["seasonNumber"]!.GetValue<int>())
            .ToList();

    [Fact]
    public void Naming_seasons_ticks_exactly_those()
    {
        var series = Series(0, 1, 2, 3);
        RequestWorker.ApplySeasons(series, new[] { 2 });
        Assert.Equal(new[] { 2 }, Monitored(series));
    }

    [Fact]
    public void Naming_no_seasons_ticks_every_real_one_and_not_the_specials()
    {
        // Season 0 is the specials folder. "The whole show" to a person does not include it, and
        // Sonarr's own default agrees.
        var series = Series(0, 1, 2);
        RequestWorker.ApplySeasons(series, Array.Empty<int>());
        Assert.Equal(new[] { 1, 2 }, Monitored(series));
    }

    [Fact]
    public void Reapplying_unticks_a_season_that_is_no_longer_wanted()
    {
        // The series may already be in Sonarr from an earlier request. Applying the new list has to
        // be a *set*, not an addition, or a request for season 3 quietly re-downloads seasons 1 and
        // 2 that somebody previously asked for and then withdrew.
        var series = Series(1, 2, 3);
        RequestWorker.ApplySeasons(series, new[] { 1, 2 });
        Assert.Equal(new[] { 1, 2 }, Monitored(series));
        RequestWorker.ApplySeasons(series, new[] { 3 });
        Assert.Equal(new[] { 3 }, Monitored(series));
    }

    [Fact]
    public void A_season_the_series_does_not_have_is_simply_not_ticked()
    {
        var series = Series(1, 2);
        RequestWorker.ApplySeasons(series, new[] { 9 });
        Assert.Empty(Monitored(series));
    }

    [Fact]
    public void A_resource_with_no_seasons_array_is_left_alone_rather_than_throwing()
    {
        // A film resource, or a Sonarr response shape that has moved. Neither is worth an exception
        // inside the fulfilment loop.
        var notASeries = new JsonObject { ["title"] = "Big Buck Bunny" };
        RequestWorker.ApplySeasons(notASeries, new[] { 1 });
        Assert.Null(notASeries["seasons"]);
    }

    private static JsonObject Episode(int id, int season, int number, bool monitored, bool hasFile)
        => new()
        {
            ["id"] = id,
            ["seasonNumber"] = season,
            ["episodeNumber"] = number,
            ["monitored"] = monitored,
            ["hasFile"] = hasFile,
        };

    [Fact]
    public void Only_the_monitored_missing_episodes_of_the_wanted_seasons_are_searched_for()
    {
        var episodes = new List<JsonObject>
        {
            Episode(1, 1, 1, monitored: true, hasFile: false),
            Episode(2, 1, 2, monitored: true, hasFile: true),   // already here
            Episode(3, 1, 3, monitored: false, hasFile: false), // not asked for
            Episode(4, 2, 1, monitored: true, hasFile: false),  // another season
        };

        Assert.Equal(new[] { 1 }, RequestWorker.MissingEpisodeIds(episodes, new[] { 1 }));
    }

    [Fact]
    public void No_seasons_named_means_every_season_but_the_specials()
    {
        var episodes = new List<JsonObject>
        {
            Episode(10, 0, 1, monitored: true, hasFile: false),
            Episode(11, 1, 1, monitored: true, hasFile: false),
            Episode(12, 2, 1, monitored: true, hasFile: false),
        };

        Assert.Equal(new[] { 11, 12 }, RequestWorker.MissingEpisodeIds(episodes, Array.Empty<int>()));
    }

    [Fact]
    public void Episodes_come_back_in_season_then_episode_order()
    {
        // Sonarr returns them in whatever order it likes. A search that asks for S02E05 before
        // S01E01 gets the same releases, but the log reads as though the request were random.
        var episodes = new List<JsonObject>
        {
            Episode(5, 2, 5, monitored: true, hasFile: false),
            Episode(6, 1, 2, monitored: true, hasFile: false),
            Episode(7, 1, 1, monitored: true, hasFile: false),
        };

        Assert.Equal(new[] { 7, 6, 5 }, RequestWorker.MissingEpisodeIds(episodes, new[] { 1, 2 }));
    }

    [Fact]
    public void An_episode_with_no_id_is_skipped_rather_than_searched_for_as_zero()
    {
        var episodes = new List<JsonObject>
        {
            new() { ["seasonNumber"] = 1, ["episodeNumber"] = 1, ["monitored"] = true, ["hasFile"] = false },
            Episode(9, 1, 2, monitored: true, hasFile: false),
        };

        Assert.Equal(new[] { 9 }, RequestWorker.MissingEpisodeIds(episodes, new[] { 1 }));
    }

    [Fact]
    public void Nothing_missing_is_an_empty_list_rather_than_a_search_for_everything()
    {
        // The difference between "we are done" and "ask the indexer about the whole show".
        var episodes = new List<JsonObject>
        {
            Episode(1, 1, 1, monitored: true, hasFile: true),
        };

        Assert.Empty(RequestWorker.MissingEpisodeIds(episodes, new[] { 1 }));
    }

    [Theory]
    [InlineData("episode:tvdb:73739:s02e05", 2)]
    [InlineData("episode:tvdb:73739:s01e01", 1)]
    [InlineData("episode:tvdb:73739:s10e22", 10)]
    [InlineData("episode:tvdb:73739:S03E01", 3)]
    public void The_season_comes_out_of_an_episode_key(string key, int expected)
    {
        Assert.Equal(expected, RequestWorker.SeasonOf(key));
    }

    [Theory]
    [InlineData("movie:tmdb:10378")]
    [InlineData("episode:tvdb:73739:")]
    [InlineData("episode:tvdb:73739")]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("episode:tvdb:73739:nonsense")]
    public void Anything_that_is_not_an_episode_key_has_no_season(string? key)
    {
        // Null rather than zero: zero is the specials season and a real answer.
        Assert.Null(RequestWorker.SeasonOf(key));
    }
}
