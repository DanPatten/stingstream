namespace NzbWebDAV.Config.Scheduling;

public readonly record struct HealthWorkAdmission(
    bool ChecksOpen,
    bool RepairsOpen,
    DateTimeOffset? NextChecksChange,
    DateTimeOffset? NextRepairsChange,
    string TimeZoneId,
    bool ManualRunActive);

/// <summary>
/// Shared in-memory health-check / repair admission, including the manual "run now" override.
/// Never writes <c>queue.paused</c>.
/// </summary>
public sealed class HealthWorkSchedulePolicy(ConfigManager configManager)
{
    private int _manualRun;

    public bool IsManualRunActive => Volatile.Read(ref _manualRun) == 1;

    public bool BeginManualRun() => Interlocked.Exchange(ref _manualRun, 1) == 1;

    public void EndManualRun() => Interlocked.Exchange(ref _manualRun, 0);

    public HealthWorkAdmission Evaluate(DateTimeOffset utcNow, TimeZoneInfo? timeZone = null)
    {
        var tz = timeZone ?? TimeZoneInfo.Local;
        var checks = WeeklyWindowEvaluator.Evaluate(
            configManager.GetRepairHealthcheckSchedule(), utcNow, tz);
        var repairs = WeeklyWindowEvaluator.Evaluate(
            configManager.GetRepairActionSchedule(), utcNow, tz);
        var manual = IsManualRunActive;
        return new HealthWorkAdmission(
            ChecksOpen: checks.IsOpen || manual,
            RepairsOpen: repairs.IsOpen,
            NextChecksChange: checks.NextChange,
            NextRepairsChange: repairs.NextChange,
            TimeZoneId: tz.Id,
            ManualRunActive: manual);
    }
}
