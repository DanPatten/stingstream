using StingStream.Core.Playback;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Which question an index entry answers, when sixty are asked at once.
/// </summary>
/// <remarks>
/// The catalogue annotates a whole page of results with what the group already holds. Asking per
/// title walks the whole group index once per title, which is fine for the twenty a search returns
/// and is the difference between a feed that draws and a feed that hangs at sixty. The batched path
/// walks it once and buckets as it goes, and this is the rule it buckets by: a film answers to its
/// own key, an episode answers to the series it belongs to. Get the trailing colon wrong and every
/// series in the catalogue silently reports no holders.
/// </remarks>
public sealed class CandidateBucketTests
{
    [Fact]
    public void AFilmAnswersToItsOwnKey()
    {
        Assert.Equal("movie:tmdb:603", FederatedSourceService.BucketOf("movie:tmdb:603"));
    }

    [Fact]
    public void AnEpisodeAnswersToItsSeriesPrefix()
    {
        // The prefix `InventoryKeys.SeriesPrefix` builds, trailing colon and all.
        Assert.Equal(
            "episode:tvdb:73739:",
            FederatedSourceService.BucketOf("episode:tvdb:73739:s01e01"));
    }

    [Fact]
    public void TwoEpisodesOfOneShowAnswerToTheSameThing()
    {
        Assert.Equal(
            FederatedSourceService.BucketOf("episode:tvdb:73739:s01e01"),
            FederatedSourceService.BucketOf("episode:tvdb:73739:s04e12"));
    }

    [Fact]
    public void TwoShowsDoNot()
    {
        Assert.NotEqual(
            FederatedSourceService.BucketOf("episode:tvdb:73739:s01e01"),
            FederatedSourceService.BucketOf("episode:tvdb:7373:s01e01"));
    }
}
