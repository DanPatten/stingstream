namespace NzbWebDAV.Config.Scheduling;

public readonly record struct WeeklyWindowEvaluation(bool IsOpen, DateTimeOffset? NextChange);

/// <summary>
/// Evaluates weekly admission windows against a timezone's local wall clock.
/// Minutes are half-open <c>[start, end)</c>. Overnight windows use the starting day.
/// </summary>
public static class WeeklyWindowEvaluator
{
    private static readonly TimeSpan SearchHorizon = TimeSpan.FromDays(8);
    private static readonly TimeSpan Step = TimeSpan.FromMinutes(1);

    public static WeeklyWindowEvaluation Evaluate(
        WeeklyWindowSchedule? schedule,
        DateTimeOffset utcNow,
        TimeZoneInfo timeZone)
    {
        ArgumentNullException.ThrowIfNull(timeZone);
        if (schedule is null || !schedule.Enabled)
            return new WeeklyWindowEvaluation(true, null);

        var windows = (schedule.Windows ?? [])
            .Where(window => WeeklyWindowSchedule.TryValidateWindow(window, out _))
            .ToArray();
        if (windows.Length == 0)
            return new WeeklyWindowEvaluation(true, null);

        var isOpen = IsOpenAt(windows, utcNow, timeZone);
        var next = FindNextChange(windows, utcNow, timeZone, isOpen);
        return new WeeklyWindowEvaluation(isOpen, next);
    }

    public static bool IsOpenAt(
        IReadOnlyList<WeeklyWindow> windows,
        DateTimeOffset utcNow,
        TimeZoneInfo timeZone)
    {
        var local = TimeZoneInfo.ConvertTime(utcNow, timeZone);
        var day = (int)local.DayOfWeek;
        var minute = local.Hour * 60 + local.Minute;
        return windows.Any(window =>
            window.Days.Distinct().Any(startDay =>
                Contains(startDay, window.StartMinute, window.EndMinute, day, minute)));
    }

    private static bool Contains(int startDay, int startMinute, int endMinute, int day, int minute)
    {
        if (startMinute < endMinute)
            return day == startDay && minute >= startMinute && minute < endMinute;

        // Overnight: [start, 1440) on the starting day, then [0, end) on the next day.
        var nextDay = (startDay + 1) % 7;
        return (day == startDay && minute >= startMinute)
               || (day == nextDay && minute < endMinute);
    }

    private static DateTimeOffset? FindNextChange(
        IReadOnlyList<WeeklyWindow> windows,
        DateTimeOffset utcNow,
        TimeZoneInfo timeZone,
        bool currentlyOpen)
    {
        var aligned = AlignToUtcMinute(utcNow);
        var deadline = aligned + SearchHorizon;
        for (var cursor = aligned + Step; cursor <= deadline; cursor += Step)
        {
            if (IsOpenAt(windows, cursor, timeZone) != currentlyOpen)
                return cursor;
        }

        return null;
    }

    private static DateTimeOffset AlignToUtcMinute(DateTimeOffset value)
    {
        var utc = value.ToUniversalTime();
        return new DateTimeOffset(utc.Year, utc.Month, utc.Day, utc.Hour, utc.Minute, 0, TimeSpan.Zero);
    }
}
