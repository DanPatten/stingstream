using System.Text.Json;
using System.Text.Json.Serialization;

namespace NzbWebDAV.Config.Scheduling;

/// <summary>
/// Weekly admission windows in local wall-clock minutes.
/// Empty / disabled schedules are unrestricted (today's behavior).
/// </summary>
public sealed class WeeklyWindowSchedule
{
    public static readonly WeeklyWindowSchedule Unrestricted = new()
    {
        Enabled = false,
        Windows = [],
    };

    public bool Enabled { get; init; }

    public WeeklyWindow[] Windows { get; init; } = [];

    public static bool TryParse(string? json, out WeeklyWindowSchedule schedule, out string? error)
    {
        schedule = Unrestricted;
        error = null;
        if (string.IsNullOrWhiteSpace(json))
            return true;

        try
        {
            var parsed = JsonSerializer.Deserialize<WeeklyWindowSchedule>(json, ParseOptions);
            if (parsed is null)
            {
                error = "Schedule JSON was empty.";
                return false;
            }

            if (!TryValidate(parsed, out error))
                return false;

            schedule = parsed;
            return true;
        }
        catch (JsonException e)
        {
            error = e.Message;
            return false;
        }
    }

    public static bool TryValidate(WeeklyWindowSchedule schedule, out string? error)
    {
        error = null;
        if (!schedule.Enabled)
            return true;

        var windows = schedule.Windows ?? [];
        if (windows.Length == 0)
        {
            error = "Enabled schedules must include at least one window.";
            return false;
        }

        foreach (var window in windows)
        {
            if (!TryValidateWindow(window, out error))
                return false;
        }

        return true;
    }

    public static bool TryValidateWindow(WeeklyWindow window, out string? error)
    {
        error = null;
        var days = window.Days ?? [];
        if (days.Length == 0)
        {
            error = "Each window must include at least one weekday.";
            return false;
        }

        foreach (var day in days)
        {
            if (day is < 0 or > 6)
            {
                error = "Weekdays must be 0 (Sunday) through 6 (Saturday).";
                return false;
            }
        }

        if (window.StartMinute is < 0 or > 1439 || window.EndMinute is < 0 or > 1439)
        {
            error = "Window minutes must be between 0 and 1439.";
            return false;
        }

        if (window.StartMinute == window.EndMinute)
        {
            error = "Window start and end minutes cannot be equal.";
            return false;
        }

        return true;
    }

    internal static readonly JsonSerializerOptions ParseOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    internal static readonly JsonSerializerOptions StrictOptions = new()
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };
}

public sealed class WeeklyWindow
{
    public int[] Days { get; init; } = [];

    public int StartMinute { get; init; }

    public int EndMinute { get; init; }
}
