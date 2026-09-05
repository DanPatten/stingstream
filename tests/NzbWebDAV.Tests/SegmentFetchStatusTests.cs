using NzbWebDAV.Database.Models.Metrics;

namespace NzbWebDAV.Tests;

/// <summary>
/// Overview Errors exclude expected provider misses (Missing). These ordinal
/// values are baked into MetricsRollupService SQL (Status = 1 / NOT IN (0, 1)).
/// </summary>
public class SegmentFetchStatusTests
{
    [Fact]
    public void OkAndMissingOrdinals_MatchRollupSqlConstants()
    {
        Assert.Equal(0, (int)SegmentFetch.FetchStatus.Ok);
        Assert.Equal(1, (int)SegmentFetch.FetchStatus.Missing);
    }

    [Theory]
    [InlineData(SegmentFetch.FetchStatus.Ok, false)]
    [InlineData(SegmentFetch.FetchStatus.Missing, false)]
    [InlineData(SegmentFetch.FetchStatus.Timeout, true)]
    [InlineData(SegmentFetch.FetchStatus.Corrupt, true)]
    [InlineData(SegmentFetch.FetchStatus.Auth, true)]
    [InlineData(SegmentFetch.FetchStatus.Network, true)]
    [InlineData(SegmentFetch.FetchStatus.Other, true)]
    public void IsHardError_ExcludesOkAndMissing(SegmentFetch.FetchStatus status, bool expected)
    {
        Assert.Equal(expected, IsHardError(status));
    }

    [Theory]
    [InlineData(SegmentFetch.FetchStatus.Ok, false)]
    [InlineData(SegmentFetch.FetchStatus.Missing, true)]
    [InlineData(SegmentFetch.FetchStatus.Timeout, false)]
    public void IsMiss_OnlyMissing(SegmentFetch.FetchStatus status, bool expected)
    {
        Assert.Equal(expected, status == SegmentFetch.FetchStatus.Missing);
    }

    private static bool IsHardError(SegmentFetch.FetchStatus status) =>
        status != SegmentFetch.FetchStatus.Ok && status != SegmentFetch.FetchStatus.Missing;
}
