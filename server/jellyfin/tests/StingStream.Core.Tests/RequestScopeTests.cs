using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
using StingStream.Core.Requests;
using Xunit;

namespace StingStream.Core.Tests;

public class RequestScopeTests
{
    [Theory]
    [InlineData("s01e02", true)]
    [InlineData("s100e123", true)]
    [InlineData("s001e002", false)]
    [InlineData("s00e01", false)]
    [InlineData("s01e00", false)]
    [InlineData("s1e2", false)]
    [InlineData("s01e02:extra", false)]
    public void Episode_keys_are_bounded_and_canonical(string key, bool expected)
        => Assert.Equal(expected, RequestScope.IsValid(new[] { key }));

    [Fact]
    public void Adding_an_episode_does_not_request_its_whole_season()
    {
        var row = new RequestRow { Episodes = new() { "s01e02" } };
        RequestScope.Merge(row, Array.Empty<int>(), new[] { "s02e03" });
        Assert.Empty(row.Seasons);
        Assert.Equal(new[] { "s01e02", "s02e03" }, row.Episodes);
        Assert.False(RequestScope.Contains(row.Seasons, row.Episodes, 1, 1));
        Assert.True(RequestScope.Contains(row.Seasons, row.Episodes, 2, 3));
        RequestScope.Merge(row, new[] { 1 }, Array.Empty<string>());
        Assert.Equal(new[] { 1 }, row.Seasons);
        Assert.Equal(new[] { "s02e03" }, row.Episodes);
        RequestScope.Merge(row, Array.Empty<int>(), Array.Empty<string>());
        Assert.Empty(row.Seasons);
        Assert.Empty(row.Episodes);
        Assert.True(RequestScope.Contains(row.Seasons, row.Episodes, 9, 1));
    }

    [Fact]
    public void An_episode_request_searches_only_selected_missing_episodes()
    {
        var episodes = new List<JsonObject>
        {
            Episode(1, 1, false), Episode(2, 2, false), Episode(3, 3, true),
        };
        Assert.Equal(new[] { 2 }, RequestWorker.MissingEpisodeIds(episodes, Array.Empty<int>(), new[] { "s01e02", "s01e03" }));
    }

    [Fact]
    public void Withdrawal_keeps_other_episodes_and_unidentified_season_packs()
    {
        var queue = new List<JsonObject>
        {
            new() { ["seriesId"] = 5, ["episode"] = Episode(1, 1, false) },
            new() { ["seriesId"] = 5, ["episode"] = Episode(2, 2, false) },
            new() { ["seriesId"] = 5, ["seasonNumber"] = 1 },
            new() { ["seriesId"] = 6, ["episode"] = Episode(2, 2, false) },
        };
        var selected = RequestWithdrawal.Mine(queue, 5, false, Array.Empty<int>(), new[] { "s01e02" }).ToList();
        Assert.Single(selected);
        Assert.Same(queue[1], selected[0]);
    }

    private static JsonObject Episode(int id, int number, bool hasFile)
        => new() { ["id"] = id, ["seasonNumber"] = 1, ["episodeNumber"] = number, ["monitored"] = true, ["hasFile"] = hasFile };
}
