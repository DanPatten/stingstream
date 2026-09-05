using NzbWebDAV.Services.Benchmark;

namespace NzbWebDAV.Tests.Services.Benchmark;

public class BenchmarkSegmentPoolTests
{
    [Fact]
    public void Next_ReturnsIdsInRoundRobinOrder()
    {
        var pool = new BenchmarkSegmentPool(["a", "b", "c"]);

        var actual = Enumerable.Range(0, 4).Select(_ => pool.Next()).ToList();

        Assert.Equal(["a", "b", "c", "a"], actual);
    }

    [Fact]
    public void MarkDead_SkipsIdOnSubsequentCalls()
    {
        var pool = new BenchmarkSegmentPool(["a", "b", "c"]);
        pool.MarkDead("b");

        var actual = Enumerable.Range(0, 4).Select(_ => pool.Next()).ToList();

        Assert.DoesNotContain("b", actual);
        Assert.Equal(["a", "c", "a", "c"], actual);
    }

    [Fact]
    public void WrappedAround_BecomesTrueAfterCountIsExceeded()
    {
        var pool = new BenchmarkSegmentPool(["a", "b", "c"]);

        pool.Next();
        pool.Next();
        pool.Next();
        Assert.False(pool.WrappedAround);

        pool.Next();
        Assert.True(pool.WrappedAround);
    }

    [Fact]
    public void Next_WhenAllIdsAreDead_StillReturnsAValue()
    {
        var pool = new BenchmarkSegmentPool(["a", "b"]);
        pool.MarkDead("a");
        pool.MarkDead("b");

        var value = pool.Next();

        Assert.Contains(value, new[] { "a", "b" });
    }
}
