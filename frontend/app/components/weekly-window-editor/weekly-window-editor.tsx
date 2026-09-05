import { Alert, Button, Checkbox, Icon, Toggle } from "~/components/ui";

export type WeeklyWindowJson = {
  Enabled: boolean;
  Windows: WeeklyWindowEntry[];
};

export type WeeklyWindowEntry = {
  Days: number[];
  StartMinute: number;
  EndMinute: number;
};

const WEEKDAYS: { day: number; label: string }[] = [
  { day: 0, label: "Sun" },
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
];

const DEFAULT_WINDOW: WeeklyWindowEntry = {
  Days: [1, 2, 3, 4, 5],
  StartMinute: 540,
  EndMinute: 1020,
};

export function isWeeklyWindowScheduleJsonValid(value: string | undefined): boolean {
  if (value == null || value.trim() === "") return true;
  const parsed = parseWeeklyWindowSchedule(value);
  return parsed.ok;
}

export function parseWeeklyWindowSchedule(
  value: string,
): { ok: true; schedule: WeeklyWindowJson } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return { ok: false, error: "Schedule JSON is not valid." };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Schedule JSON must be an object." };
  }
  const record = raw as Record<string, unknown>;
  const enabledRaw = record["Enabled"] ?? record["enabled"];
  if (enabledRaw !== undefined && typeof enabledRaw !== "boolean") {
    return { ok: false, error: "Enabled must be a boolean." };
  }
  const enabled = enabledRaw ?? false;
  const windowsRaw = record["Windows"] ?? record["windows"];
  if (windowsRaw == null) {
    return enabled
      ? { ok: false, error: "Enabled schedules must include at least one window." }
      : { ok: true, schedule: { Enabled: false, Windows: [] } };
  }
  if (!Array.isArray(windowsRaw)) {
    return { ok: false, error: "Windows must be an array." };
  }
  const windows: WeeklyWindowEntry[] = [];
  for (const item of windowsRaw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "Each window must be an object." };
    }
    const window = item as Record<string, unknown>;
    const daysRaw = window["Days"] ?? window["days"];
    const start = Number(window["StartMinute"] ?? window["startMinute"]);
    const end = Number(window["EndMinute"] ?? window["endMinute"]);
    if (!Array.isArray(daysRaw) || daysRaw.length === 0) {
      return { ok: false, error: "Each window must include at least one weekday." };
    }
    const days: number[] = [];
    for (const day of daysRaw) {
      const n = Number(day);
      if (!Number.isInteger(n) || n < 0 || n > 6) {
        return { ok: false, error: "Weekdays must be 0 (Sunday) through 6 (Saturday)." };
      }
      days.push(n);
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      start > 1439 ||
      end < 0 ||
      end > 1439
    ) {
      return { ok: false, error: "Window minutes must be between 0 and 1439." };
    }
    if (start === end) {
      return { ok: false, error: "Window start and end minutes cannot be equal." };
    }
    windows.push({
      Days: [...new Set(days)].sort((a, b) => a - b),
      StartMinute: start,
      EndMinute: end,
    });
  }
  if (enabled && windows.length === 0) {
    return { ok: false, error: "Enabled schedules must include at least one window." };
  }
  return { ok: true, schedule: { Enabled: enabled, Windows: windows } };
}

export function serializeWeeklyWindowSchedule(schedule: WeeklyWindowJson): string {
  if (!schedule.Enabled) return "";
  return JSON.stringify({
    Enabled: true,
    Windows: schedule.Windows.map((window) => ({
      Days: window.Days,
      StartMinute: window.StartMinute,
      EndMinute: window.EndMinute,
    })),
  });
}

function minutesToTime(minute: number): string {
  const hours = Math.floor(minute / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (minute % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function timeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

type WeeklyWindowEditorProps = {
  id: string;
  value: string;
  onChange: (next: string) => void;
  description?: string;
};

export function WeeklyWindowEditor({ id, value, onChange, description }: WeeklyWindowEditorProps) {
  const emptySchedule: WeeklyWindowJson = { Enabled: false, Windows: [] };
  const parsed =
    value.trim() === ""
      ? { ok: true as const, schedule: emptySchedule }
      : parseWeeklyWindowSchedule(value);
  const schedule: WeeklyWindowJson = parsed.ok ? parsed.schedule : emptySchedule;

  const emit = (next: WeeklyWindowJson) => {
    onChange(serializeWeeklyWindowSchedule(next));
  };

  return (
    <div className="space-y-3">
      <Toggle
        id={`${id}-enabled`}
        checked={schedule.Enabled}
        onChange={(event) => {
          if (event.target.checked) {
            emit({
              Enabled: true,
              Windows: schedule.Windows.length > 0 ? schedule.Windows : [DEFAULT_WINDOW],
            });
          } else {
            emit({ Enabled: false, Windows: [] });
          }
        }}
        label={<span className="text-sm text-base-content">Limit to weekly time windows</span>}
      />
      {description && (
        <p className="text-[11px] leading-relaxed text-base-content/45">{description}</p>
      )}
      {!parsed.ok && (
        <Alert variant="warning" className="alert-soft text-xs">
          <Icon name="warning" className="shrink-0 !text-[18px]" />
          <span>{parsed.error}</span>
        </Alert>
      )}
      {schedule.Enabled && (
        <div className="space-y-3">
          {schedule.Windows.map((window, index) => {
            const overnight = window.EndMinute < window.StartMinute;
            return (
              <fieldset
                key={`${id}-window-${index}`}
                className="fieldset rounded-box border border-base-content/10 bg-base-200/40 p-3"
              >
                <legend className="fieldset-legend text-xs font-medium text-base-content/70">
                  Window {index + 1}
                </legend>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map(({ day, label }) => {
                    const checked = window.Days.includes(day);
                    const checkboxId = `${id}-w${index}-d${day}`;
                    return (
                      <label
                        key={day}
                        htmlFor={checkboxId}
                        className="label cursor-pointer gap-1.5 px-0"
                      >
                        <Checkbox
                          id={checkboxId}
                          className="checkbox-sm"
                          checked={checked}
                          onChange={(event) => {
                            const days = event.target.checked
                              ? [...window.Days, day].sort((a, b) => a - b)
                              : window.Days.filter((item) => item !== day);
                            const windows = schedule.Windows.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, Days: days } : item,
                            );
                            emit({ ...schedule, Windows: windows });
                          }}
                        />
                        <span className="text-xs">{label}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1 text-xs text-base-content/70">
                    Start
                    <input
                      type="time"
                      className="input input-sm"
                      value={minutesToTime(window.StartMinute)}
                      onChange={(event) => {
                        const next = timeToMinutes(event.target.value);
                        if (next == null) return;
                        const windows = schedule.Windows.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, StartMinute: next } : item,
                        );
                        emit({ ...schedule, Windows: windows });
                      }}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-base-content/70">
                    End
                    <input
                      type="time"
                      className="input input-sm"
                      value={minutesToTime(window.EndMinute)}
                      onChange={(event) => {
                        const next = timeToMinutes(event.target.value);
                        if (next == null) return;
                        const windows = schedule.Windows.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, EndMinute: next } : item,
                        );
                        emit({ ...schedule, Windows: windows });
                      }}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    className="btn-error"
                    onClick={() => {
                      const windows = schedule.Windows.filter(
                        (_, itemIndex) => itemIndex !== index,
                      );
                      emit({
                        Enabled: windows.length > 0,
                        Windows: windows,
                      });
                    }}
                    disabled={schedule.Windows.length <= 1}
                  >
                    Remove
                  </Button>
                </div>
                {overnight && (
                  <p className="mt-2 text-[11px] leading-relaxed text-base-content/45">
                    This window continues overnight onto the next calendar day.
                  </p>
                )}
              </fieldset>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="small"
            onClick={() => emit({ ...schedule, Windows: [...schedule.Windows, DEFAULT_WINDOW] })}
          >
            Add window
          </Button>
          <p className="text-[11px] leading-relaxed text-base-content/45">
            Times use this host&apos;s local timezone (container <code>TZ</code>). Work already in
            progress finishes if a window closes; new work waits until the next open window.
            Playback is never gated.
          </p>
        </div>
      )}
    </div>
  );
}
