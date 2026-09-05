using NzbWebDAV.Database.Models;
using NzbWebDAV.Services.Benchmark;

namespace NzbWebDAV.Tests.Services.Benchmark;

public class BenchmarkCorpusProviderTests
{
    [Fact]
    public void RankCompletedCandidates_PrefersRecentHealthThenSizeThenRecency()
    {
        var now = new DateTimeOffset(2026, 7, 17, 12, 0, 0, TimeSpan.Zero);
        var healthySmallOld = Item("healthy-small", fileSize: 10, createdAt: now.AddDays(-10).DateTime, lastHealth: now.AddDays(-1));
        var healthyLarge = Item("healthy-large", fileSize: 500, createdAt: now.AddDays(-5).DateTime, lastHealth: now.AddDays(-2));
        var unhealthyLarge = Item("unhealthy-large", fileSize: 900, createdAt: now.AddDays(-1).DateTime, lastHealth: now.AddDays(-60));
        var neverCheckedRecent = Item("never-checked", fileSize: 800, createdAt: now.DateTime, lastHealth: null);

        var ranked = BenchmarkCorpusProvider.RankCompletedCandidates(
            [healthySmallOld, unhealthyLarge, neverCheckedRecent, healthyLarge],
            now);

        Assert.Equal(
            ["healthy-large", "healthy-small", "unhealthy-large", "never-checked"],
            ranked.Select(x => x.Name).ToArray());
    }

    [Fact]
    public void RankCompletedCandidates_CapsCrackOpenList()
    {
        var now = DateTimeOffset.UtcNow;
        var items = Enumerable.Range(0, 80)
            .Select(i => Item($"f{i}", fileSize: i, createdAt: now.AddMinutes(-i).DateTime, lastHealth: now))
            .ToList();

        var ranked = BenchmarkCorpusProvider.RankCompletedCandidates(items, now);

        Assert.Equal(60, ranked.Count);
        Assert.Equal(79, ranked[0].FileSize);
        Assert.Equal(20, ranked[^1].FileSize);
    }

    private static DavItem Item(string name, long fileSize, DateTime createdAt, DateTimeOffset? lastHealth)
    {
        var id = Guid.NewGuid();
        return new DavItem
        {
            Id = id,
            IdPrefix = id.ToString("N")[..5],
            Name = name,
            Path = "/" + name,
            Type = DavItem.ItemType.UsenetFile,
            SubType = DavItem.ItemSubType.NzbFile,
            FileSize = fileSize,
            CreatedAt = createdAt,
            LastHealthCheck = lastHealth,
        };
    }
}
