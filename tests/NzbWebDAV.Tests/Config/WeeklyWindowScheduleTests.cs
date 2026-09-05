using NzbWebDAV.Config;
using NzbWebDAV.Config.Scheduling;
using NzbWebDAV.Database.Models;
using NzbWebDAV.Tests.TestUtils;
using Serilog;
using Serilog.Core;
using Serilog.Events;

namespace NzbWebDAV.Tests.Config;

[Collection(nameof(GlobalLoggerCollection))]
public class WeeklyWindowScheduleTests
{
    private static ConfigItem Item(string name, string value) =>
        new() { ConfigName = name, ConfigValue = value };

    [Fact]
    public void TryParse_Empty_IsUnrestricted()
    {
        Assert.True(WeeklyWindowSchedule.TryParse("", out var schedule, out var error));
        Assert.Null(error);
        Assert.False(schedule.Enabled);
    }

    [Fact]
    public void TryParse_EnabledWithoutWindows_Fails()
    {
        Assert.False(WeeklyWindowSchedule.TryParse("""{"Enabled":true,"Windows":[]}""", out _, out var error));
        Assert.Contains("window", error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TryParse_EqualStartAndEnd_Fails()
    {
        const string json = """{"Enabled":true,"Windows":[{"Days":[1],"StartMinute":0,"EndMinute":0}]}""";
        Assert.False(WeeklyWindowSchedule.TryParse(json, out _, out var error));
        Assert.Contains("equal", error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ConfigManager_RejectsInvalidSchedule()
    {
        var ex = Assert.Throws<ArgumentException>(() =>
            ConfigManager.ValidateConfigItems(
                new List<ConfigItem> { Item(ConfigKeys.QueueProcessingSchedule, "{not-json") }));
        Assert.Contains("JSON", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ConfigManager_InvalidStoredSchedule_IsUnrestricted()
    {
        var config = new ConfigManager();
        typeof(ConfigManager)
            .GetField("_config", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
            ?.SetValue(config, new Dictionary<string, string> { [ConfigKeys.QueueProcessingSchedule] = "{bad" });
        var schedule = config.GetQueueProcessingSchedule();
        Assert.False(schedule.Enabled);
    }

    [Fact]
    public void QueueAdmission_ManualPauseAndSchedule()
    {
        var config = new ConfigManager();
        config.UpdateValues(new List<ConfigItem> { Item(ConfigKeys.QueuePaused, "true") });
        Assert.True(config.IsQueueEffectivelyPaused());
        Assert.Equal("0", config.GetQueuePauseInt());

        var local = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.Local);
        var minute = local.Hour * 60 + local.Minute;
        var start = (minute + 120) % 1440;
        var end = (start + 60) % 1440;
        if (end == start) end = (start + 1) % 1440;
        var json =
            $$"""{"Enabled":true,"Windows":[{"Days":[0,1,2,3,4,5,6],"StartMinute":{{start}},"EndMinute":{{end}}}]}""";
        config.UpdateValues(new List<ConfigItem>
        {
            Item(ConfigKeys.QueuePaused, "false"),
            Item(ConfigKeys.QueueProcessingSchedule, json),
        });
        Assert.True(config.IsQueueEffectivelyPaused());
        Assert.NotEqual("0", config.GetQueuePauseInt());
        Assert.True(int.Parse(config.GetQueuePauseInt()) > 0);
    }

    [Fact]
    public void GetQueuePauseInt_RoundsUpToNextChange()
    {
        var tz = TimeZoneInfo.Local;
        var localWall = new DateTime(2026, 8, 24, 8, 59, 49, 200, DateTimeKind.Unspecified);
        var utcNow = new DateTimeOffset(TimeZoneInfo.ConvertTimeToUtc(localWall, tz));
        const string json =
            """{"Enabled":true,"Windows":[{"Days":[1],"StartMinute":540,"EndMinute":1020}]}""";
        var config = new ConfigManager();
        config.UpdateValues(new List<ConfigItem>
        {
            Item(ConfigKeys.QueuePaused, "false"),
            Item(ConfigKeys.QueueProcessingSchedule, json),
        });

        Assert.True(config.IsQueueEffectivelyPaused(utcNow));
        Assert.Equal("11", config.GetQueuePauseInt(utcNow));
    }

    [Fact]
    public async Task ConfigManager_InvalidStoredSchedule_LogsOnceUnderConcurrency()
    {
        var config = ConfigWithSchedule("{bad");
        var sink = new CollectingSink();
        var previous = Log.Logger;
        Log.Logger = new LoggerConfiguration()
            .MinimumLevel.Warning()
            .WriteTo.Sink(sink)
            .CreateLogger();
        try
        {
            await Task.WhenAll(Enumerable.Range(0, 32).Select(_ =>
                Task.Run(config.GetQueueProcessingSchedule)));
            Assert.Equal(1, sink.Events.Count(IsInvalidScheduleWarning));
        }
        finally
        {
            Log.Logger = previous;
        }
    }

    [Fact]
    public void ConfigManager_InvalidStoredSchedule_LogsAgainWhenRawChanges()
    {
        var config = ConfigWithSchedule("{bad");
        var sink = new CollectingSink();
        var previous = Log.Logger;
        Log.Logger = new LoggerConfiguration()
            .MinimumLevel.Warning()
            .WriteTo.Sink(sink)
            .CreateLogger();
        try
        {
            config.GetQueueProcessingSchedule();
            SetSchedule(config, "{also-bad");
            config.GetQueueProcessingSchedule();
            Assert.Equal(2, sink.Events.Count(IsInvalidScheduleWarning));
        }
        finally
        {
            Log.Logger = previous;
        }
    }

    private static ConfigManager ConfigWithSchedule(string raw)
    {
        var config = new ConfigManager();
        SetSchedule(config, raw);
        return config;
    }

    private static void SetSchedule(ConfigManager config, string raw)
    {
        typeof(ConfigManager)
            .GetField("_config", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
            ?.SetValue(config, new Dictionary<string, string> { [ConfigKeys.QueueProcessingSchedule] = raw });
    }

    private static bool IsInvalidScheduleWarning(LogEvent logEvent) =>
        logEvent.MessageTemplate.Text.Contains("Ignoring invalid", StringComparison.Ordinal);

    private sealed class CollectingSink : ILogEventSink
    {
        private readonly List<LogEvent> _events = [];

        public IReadOnlyList<LogEvent> Events
        {
            get
            {
                lock (_events) return _events.ToList();
            }
        }

        public void Emit(LogEvent logEvent)
        {
            lock (_events) _events.Add(logEvent);
        }
    }
}
