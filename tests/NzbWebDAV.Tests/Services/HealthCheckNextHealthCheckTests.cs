using NzbWebDAV.Services;

namespace NzbWebDAV.Tests.Services;

public class HealthCheckNextHealthCheckTests
{
    [Fact]
    public void ComputeNextHealthCheck_NullReleaseDate_FloorsAtOneHour()
    {
        var utcNow = new DateTimeOffset(2026, 7, 13, 12, 0, 0, TimeSpan.Zero);

        var next = HealthCheckService.ComputeNextHealthCheck(null, utcNow);

        Assert.Equal(utcNow + TimeSpan.FromHours(1), next);
    }

    [Fact]
    public void ComputeNextHealthCheck_FutureReleaseDate_FloorsAtOneHour()
    {
        var utcNow = new DateTimeOffset(2026, 7, 13, 12, 0, 0, TimeSpan.Zero);
        var futureRelease = utcNow + TimeSpan.FromDays(7);

        var next = HealthCheckService.ComputeNextHealthCheck(futureRelease, utcNow);

        Assert.Equal(utcNow + TimeSpan.FromHours(1), next);
    }

    [Fact]
    public void ComputeNextHealthCheck_RecentRelease_FloorsAtOneHour()
    {
        var utcNow = new DateTimeOffset(2026, 7, 13, 12, 0, 0, TimeSpan.Zero);
        var releaseDate = utcNow - TimeSpan.FromMinutes(10);

        var next = HealthCheckService.ComputeNextHealthCheck(releaseDate, utcNow);

        // formula would be utcNow + 10m, which is below the 1h floor
        Assert.Equal(utcNow + TimeSpan.FromHours(1), next);
    }

    [Fact]
    public void ComputeNextHealthCheck_OlderRelease_DoublesAgeSinceRelease()
    {
        var utcNow = new DateTimeOffset(2026, 7, 13, 12, 0, 0, TimeSpan.Zero);
        var releaseDate = utcNow - TimeSpan.FromDays(10);

        var next = HealthCheckService.ComputeNextHealthCheck(releaseDate, utcNow);

        // Next = Release + 2 * (Now - Release) = Now + (Now - Release) = Now + 10 days
        Assert.Equal(utcNow + TimeSpan.FromDays(10), next);
    }
}
