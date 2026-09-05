using NzbWebDAV.Config.Scheduling;

namespace NzbWebDAV.Tests.Config;

public class WeeklyWindowEvaluatorTests
{
    private static WeeklyWindowSchedule WeekdaysNineToFive() => new()
    {
        Enabled = true,
        Windows =
        [
            new WeeklyWindow
            {
                Days = [1, 2, 3, 4, 5],
                StartMinute = 9 * 60,
                EndMinute = 17 * 60,
            },
        ],
    };

    private static TimeZoneInfo Eastern()
    {
        foreach (var id in new[] { "America/New_York", "Eastern Standard Time" })
        {
            if (TimeZoneInfo.TryFindSystemTimeZoneById(id, out var timeZone))
                return timeZone;
        }

        throw new InvalidOperationException("Eastern timezone is not available on this host.");
    }

    [Fact]
    public void DisabledSchedule_IsUnrestricted()
    {
        var utc = new DateTimeOffset(2026, 8, 24, 15, 0, 0, TimeSpan.Zero);
        var result = WeeklyWindowEvaluator.Evaluate(WeeklyWindowSchedule.Unrestricted, utc, TimeZoneInfo.Utc);
        Assert.True(result.IsOpen);
        Assert.Null(result.NextChange);
    }

    [Fact]
    public void WeekdayWindow_IsHalfOpenAndLocal()
    {
        var tz = TimeZoneInfo.Utc;
        var schedule = WeekdaysNineToFive();
        var mondayStart = new DateTimeOffset(2026, 8, 24, 9, 0, 0, TimeSpan.Zero);
        var mondayEnd = new DateTimeOffset(2026, 8, 24, 17, 0, 0, TimeSpan.Zero);
        var sunday = new DateTimeOffset(2026, 8, 23, 12, 0, 0, TimeSpan.Zero);

        Assert.True(WeeklyWindowEvaluator.Evaluate(schedule, mondayStart, tz).IsOpen);
        Assert.False(WeeklyWindowEvaluator.Evaluate(schedule, mondayEnd, tz).IsOpen);
        Assert.False(WeeklyWindowEvaluator.Evaluate(schedule, sunday, tz).IsOpen);
    }

    [Fact]
    public void OvernightWindow_UsesStartingDay()
    {
        var schedule = new WeeklyWindowSchedule
        {
            Enabled = true,
            Windows =
            [
                new WeeklyWindow { Days = [5], StartMinute = 22 * 60, EndMinute = 6 * 60 },
            ],
        };
        var tz = TimeZoneInfo.Utc;
        var fridayNight = new DateTimeOffset(2026, 8, 28, 23, 0, 0, TimeSpan.Zero); // Friday
        var saturdayMorning = new DateTimeOffset(2026, 8, 29, 5, 0, 0, TimeSpan.Zero);
        var saturdayOpen = new DateTimeOffset(2026, 8, 29, 6, 0, 0, TimeSpan.Zero);

        Assert.True(WeeklyWindowEvaluator.Evaluate(schedule, fridayNight, tz).IsOpen);
        Assert.True(WeeklyWindowEvaluator.Evaluate(schedule, saturdayMorning, tz).IsOpen);
        Assert.False(WeeklyWindowEvaluator.Evaluate(schedule, saturdayOpen, tz).IsOpen);
    }

    [Fact]
    public void NextChange_ReportsUpcomingBoundary()
    {
        var tz = TimeZoneInfo.Utc;
        var mondayNoon = new DateTimeOffset(2026, 8, 24, 12, 0, 0, TimeSpan.Zero);
        var result = WeeklyWindowEvaluator.Evaluate(WeekdaysNineToFive(), mondayNoon, tz);
        Assert.True(result.IsOpen);
        Assert.Equal(new DateTimeOffset(2026, 8, 24, 17, 0, 0, TimeSpan.Zero), result.NextChange);
    }

    [Fact]
    public void SpringForward_SkipsMissingLocalHour()
    {
        var tz = Eastern();
        var schedule = new WeeklyWindowSchedule
        {
            Enabled = true,
            Windows =
            [
                new WeeklyWindow { Days = [0], StartMinute = 60, EndMinute = 180 }, // 01:00-03:00 Sunday
            ],
        };
        // 2026-03-08 07:30 UTC is 02:30 EST which does not exist; clocks jump to 03:00 EDT.
        var oneThirtyEst = new DateTimeOffset(2026, 3, 8, 6, 30, 0, TimeSpan.Zero); // 01:30 EST
        var afterJump = new DateTimeOffset(2026, 3, 8, 7, 30, 0, TimeSpan.Zero); // 03:30 EDT
        Assert.True(WeeklyWindowEvaluator.Evaluate(schedule, oneThirtyEst, tz).IsOpen);
        Assert.False(WeeklyWindowEvaluator.Evaluate(schedule, afterJump, tz).IsOpen);
    }

    [Fact]
    public void FallBack_RepeatedLocalHour_StaysOnWindow()
    {
        var tz = Eastern();
        var schedule = new WeeklyWindowSchedule
        {
            Enabled = true,
            Windows =
            [
                new WeeklyWindow { Days = [0], StartMinute = 60, EndMinute = 180 },
            ],
        };
        // 2026-11-01 05:30 UTC = 01:30 EDT; 06:30 UTC = 01:30 EST.
        var firstOneAm = new DateTimeOffset(2026, 11, 1, 5, 30, 0, TimeSpan.Zero);
        var secondOneAm = new DateTimeOffset(2026, 11, 1, 6, 30, 0, TimeSpan.Zero);
        Assert.True(WeeklyWindowEvaluator.Evaluate(schedule, firstOneAm, tz).IsOpen);
        Assert.True(WeeklyWindowEvaluator.Evaluate(schedule, secondOneAm, tz).IsOpen);
    }
}
