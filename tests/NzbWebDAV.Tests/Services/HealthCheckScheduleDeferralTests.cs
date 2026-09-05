using NzbWebDAV.Services;

namespace NzbWebDAV.Tests.Services;

public class HealthCheckScheduleDeferralTests
{
    [Fact]
    public void NextHealthCheckAfterScheduleDeferral_KeepsUrgentSentinel()
    {
        var resume = new DateTimeOffset(2026, 8, 24, 13, 0, 0, TimeSpan.Zero);
        Assert.Equal(
            DateTimeOffset.UnixEpoch,
            HealthCheckService.NextHealthCheckAfterScheduleDeferral(DateTimeOffset.UnixEpoch, resume));
    }

    [Fact]
    public void NextHealthCheckAfterScheduleDeferral_UsesWindowForRoutineRepairs()
    {
        var current = new DateTimeOffset(2026, 8, 24, 12, 0, 0, TimeSpan.Zero);
        var resume = new DateTimeOffset(2026, 8, 24, 22, 0, 0, TimeSpan.Zero);
        Assert.Equal(
            resume,
            HealthCheckService.NextHealthCheckAfterScheduleDeferral(current, resume));
    }

    [Fact]
    public void NextHealthCheckAfterScheduleDeferral_UsesWindowWhenUnset()
    {
        var resume = new DateTimeOffset(2026, 8, 24, 22, 0, 0, TimeSpan.Zero);
        Assert.Equal(
            resume,
            HealthCheckService.NextHealthCheckAfterScheduleDeferral(null, resume));
    }
}
