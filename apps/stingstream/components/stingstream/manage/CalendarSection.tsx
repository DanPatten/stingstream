import { useMemo, useState } from "react";
import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { type CalendarEntry, useCalendar } from "@/lib/stingstream/hooks";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { SegmentedControl } from "../shared/SegmentedControl";

/**
 * Manage → Calendar. Gap 5 closed.
 *
 * A list grouped by day, not a grid. A month grid is what the arrs' own web UIs
 * render and it is the wrong shape here: on a phone a month of cells is either
 * unreadable or a horizontal scroll, and the question this screen answers —
 * "what is arriving, and have I got it yet" — is a list question. The week and
 * month buttons change the *window*, not the layout.
 *
 * The window starts a week in the past in both cases, because "it came out on
 * Tuesday and I still have not got it" is what people actually come here for,
 * and a calendar that begins today cannot show it.
 */
export function CalendarSection() {
  const [span, setSpan] = useState<"week" | "month">("week");

  const { start, end } = useMemo(() => {
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 7);
    const to = new Date();
    to.setUTCDate(to.getUTCDate() + (span === "week" ? 7 : 30));
    return { start: iso(from), end: iso(to) };
  }, [span]);

  const calendar = useCalendar(start, end);
  const days = useMemo(() => groupByDay(calendar.data ?? []), [calendar.data]);

  return (
    <View>
      <Text className='text-white text-lg font-semibold mb-2'>Calendar</Text>
      <View className='-mx-4 mb-2'>
        <SegmentedControl
          segments={[
            { key: "week", label: "Next week" },
            { key: "month", label: "Next month" },
          ]}
          value={span}
          onChange={(v) => setSpan(v as "week" | "month")}
        />
      </View>

      <QueryState
        isLoading={calendar.isLoading}
        error={calendar.error}
        onRetry={calendar.refetch}
      >
        {days.length === 0 ? (
          <EmptyState
            title='Nothing scheduled'
            detail='Neither the movie manager nor the series manager has a release or an episode in this window. Add a title, or widen the range.'
          />
        ) : (
          days.map(([day, entries]) => (
            <View key={day} className='mb-3'>
              <ListGroup title={dayLabel(day)}>
                {entries.map((e) => (
                  <ListItem
                    key={`${e.App}-${e.Title}-${e.SeasonNumber}-${e.EpisodeNumber}-${e.Date}`}
                    title={titleOf(e)}
                    subtitle={subtitleOf(e)}
                    subtitleColor={
                      !e.HasFile && isPast(e.Date) && e.Monitored
                        ? "red"
                        : "default"
                    }
                    value={e.HasFile ? "Have it" : e.Monitored ? "Wanted" : "—"}
                  />
                ))}
              </ListGroup>
            </View>
          ))
        )}
      </QueryState>
    </View>
  );
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

function titleOf(e: CalendarEntry): string {
  if (e.Kind === "episode") {
    const code =
      e.SeasonNumber != null && e.EpisodeNumber != null
        ? `S${String(e.SeasonNumber).padStart(2, "0")}E${String(e.EpisodeNumber).padStart(2, "0")}`
        : "";
    return [e.Title, code].filter(Boolean).join(" ");
  }
  return `${e.Title}${e.Year ? ` (${e.Year})` : ""}`;
}

function subtitleOf(e: CalendarEntry): string {
  const bits = [e.Kind === "episode" ? e.EpisodeTitle : undefined, e.App];
  if (!e.Monitored) bits.push("unmonitored");
  return bits.filter(Boolean).join(" • ");
}

/** The day part of whatever the app gave us — RFC 3339 or a plain date. */
const dayOf = (date: string | undefined | null): string =>
  (date ?? "").slice(0, 10);

const isPast = (date: string | undefined | null): boolean =>
  dayOf(date) !== "" && dayOf(date) < iso(new Date());

function groupByDay(entries: CalendarEntry[]): [string, CalendarEntry[]][] {
  const byDay = new Map<string, CalendarEntry[]>();
  for (const e of entries) {
    const day = dayOf(e.Date);
    if (!day) continue;
    const list = byDay.get(day);
    if (list) list.push(e);
    else byDay.set(day, [e]);
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function dayLabel(day: string): string {
  const today = iso(new Date());
  if (day === today) return "Today";
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (day === iso(tomorrow)) return "Tomorrow";
  // Parsed as UTC on purpose: the day key is a UTC date and re-parsing it in the
  // device's zone would label a late-evening release as the day before.
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
