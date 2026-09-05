using NzbWebDAV.Config;
using NzbWebDAV.Config.Scheduling;
using NzbWebDAV.Database.Models;

namespace NzbWebDAV.Tests.Config;

public class HealthWorkSchedulePolicyTests
{
    private static ConfigItem Item(string name, string value) =>
        new() { ConfigName = name, ConfigValue = value };

    [Fact]
    public void ManualRun_OpensChecksOnly()
    {
        var utcNow = new DateTimeOffset(2026, 8, 24, 12, 0, 0, TimeSpan.Zero);
        const string closed =
            """{"Enabled":true,"Windows":[{"Days":[1],"StartMinute":600,"EndMinute":630}]}""";
        var config = new ConfigManager();
        config.UpdateValues(new List<ConfigItem>
        {
            Item(ConfigKeys.RepairHealthcheckSchedule, closed),
            Item(ConfigKeys.RepairActionSchedule, closed),
        });
        var policy = new HealthWorkSchedulePolicy(config);
        var before = policy.Evaluate(utcNow, TimeZoneInfo.Utc);
        Assert.False(before.ChecksOpen);
        Assert.False(before.RepairsOpen);

        Assert.False(policy.BeginManualRun());
        var during = policy.Evaluate(utcNow, TimeZoneInfo.Utc);
        Assert.True(during.ChecksOpen);
        Assert.False(during.RepairsOpen);
        Assert.True(during.ManualRunActive);

        Assert.True(policy.BeginManualRun());
        policy.EndManualRun();
        var after = policy.Evaluate(utcNow, TimeZoneInfo.Utc);
        Assert.False(after.ChecksOpen);
        Assert.False(after.ManualRunActive);
    }
}
