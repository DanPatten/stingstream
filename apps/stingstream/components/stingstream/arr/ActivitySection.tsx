import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { Text } from "@/components/common/Text";
import { FilterChip } from "@/components/filters/FilterChip";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import type { ArrQueueItem } from "@/lib/stingstream/arr-types";
import { formatBytes } from "@/lib/stingstream/arr-types";
import {
  type HistoryRecord,
  useHistory,
  useQueue,
} from "@/lib/stingstream/hooks";
import { arrAppLabel } from "../shared/arrLabels";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { CalendarSection, type CalendarSpan } from "./CalendarSection";

function progressLabel(item: ArrQueueItem): string {
  if (item.size && item.sizeleft != null) {
    const done = item.size - item.sizeleft;
    const pct = item.size > 0 ? Math.round((done / item.size) * 100) : 0;
    return `${pct}% • ${formatBytes(done)} / ${formatBytes(item.size)}`;
  }
  return item.trackedDownloadStatus ?? item.status ?? "";
}

function QueueList({
  t,
  app,
  items,
}: {
  t: TFunction;
  app: string;
  items: ArrQueueItem[];
}) {
  const label = arrAppLabel(t, app);
  if (items.length === 0) {
    return (
      <EmptyState title={t("manage.activity_empty_queue", { app: label })} />
    );
  }
  return (
    <ListGroup title={label}>
      {items.map((item) => (
        <ListItem
          key={item.id}
          title={item.title ?? `#${item.id}`}
          subtitle={[progressLabel(item), item.timeleft, item.errorMessage]
            .filter(Boolean)
            .join(" • ")}
        />
      ))}
    </ListGroup>
  );
}

type ActivityView = "queue" | "history" | "upcoming";

/**
 * The fulfilment half of Requests: what is downloading, what already did, and
 * what is due.
 *
 * Three views on one chip row rather than three sections on the screen's own
 * tab bar. The Requests bar above this is already `Tabs`, and `SegmentedControl`
 * is the same primitive — a second one directly beneath it is two identical
 * bars stacked, which is the shape this whole screen was merged to avoid. Chips
 * read as "narrow what is below", which is what these do, and `FindSection`
 * already pairs a chip row with that bar on this screen.
 *
 * Calendar used to be a section of its own next door. It is a view here because
 * it answers the same question as the other two from the other end: a request
 * that is `fulfilling` is a row in Queue, and an episode that has not aired yet
 * is a row in Upcoming. Splitting them made you check two places to learn
 * whether one thing had arrived.
 */
export function ActivitySection() {
  const { t } = useTranslation();
  const [view, setView] = useState<ActivityView>("queue");
  const [span, setSpan] = useState<CalendarSpan>("week");
  const { data: queue, isLoading, error, refetch } = useQueue();

  const views: { key: ActivityView; label: string }[] = [
    { key: "queue", label: t("manage.activity_queue_tab") },
    { key: "history", label: t("manage.activity_history_tab") },
    { key: "upcoming", label: t("requests.activity_upcoming_tab") },
  ];

  return (
    <View testID='arr-activity'>
      <View
        style={{
          flexDirection: "row",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        {views.map((v) => (
          <FilterChip
            key={v.key}
            label={v.label}
            active={view === v.key}
            onPress={() => setView(v.key)}
          />
        ))}
      </View>

      {view === "queue" && (
        <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
          <QueueList t={t} app='radarr' items={queue?.radarr ?? []} />
          <View style={{ height: 12 }} />
          <QueueList t={t} app='sonarr' items={queue?.sonarr ?? []} />
        </QueryState>
      )}

      {view === "history" && <HistoryList />}

      {view === "upcoming" && (
        <>
          {/*
            The window, not a second set of views — and it is only ever on
            screen inside Upcoming, so this is not a permanent second bar.
          */}
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
            <FilterChip
              label={t("manage.calendar_next_week")}
              active={span === "week"}
              onPress={() => setSpan("week")}
            />
            <FilterChip
              label={t("manage.calendar_next_month")}
              active={span === "month"}
              onPress={() => setSpan("month")}
            />
          </View>
          <CalendarSection span={span} />
        </>
      )}
    </View>
  );
}

/**
 * Completed grabs and imports, across both apps. Gap 6 closed.
 *
 * Paged with next/previous rather than infinite scroll, and the reason is in the
 * endpoint: the two apps have independent history tables with no shared cursor,
 * so a page holds up to `pageSize` rows *from each*, merged by date. That is
 * approximate — page two is not "the next 25 events" — and a pager makes the
 * approximation visible in a way an endless list would hide.
 */
function HistoryList() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const history = useHistory(page);
  const records = history.data?.Records ?? [];

  return (
    <QueryState
      isLoading={history.isLoading}
      error={history.error}
      onRetry={history.refetch}
    >
      {records.length === 0 ? (
        <EmptyState
          title={t("manage.activity_empty_history_title")}
          detail={t("manage.activity_empty_history_detail")}
        />
      ) : (
        <>
          <ListGroup>
            {records.map((r, i) => (
              <ListItem
                key={`${r.App}-${r.Date}-${r.SourceTitle ?? r.Title}-${i}`}
                title={titleOf(t, r)}
                subtitle={subtitleOf(t, r)}
                subtitleColor={isFailure(r) ? "red" : "default"}
                value={when(t, r.Date)}
              />
            ))}
          </ListGroup>

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 12,
            }}
          >
            <Pager
              label={t("manage.activity_newer")}
              disabled={page <= 1 || history.isFetching}
              onPress={() => setPage((p) => Math.max(1, p - 1))}
            />
            <Text variant='caption' tone='secondary'>
              {history.data?.Total
                ? t("manage.activity_page_of", {
                    page,
                    total: Math.max(
                      1,
                      Math.ceil(
                        history.data.Total / (history.data.PageSize || 25),
                      ),
                    ),
                  })
                : t("manage.activity_page_label", { page })}
            </Text>
            <Pager
              label={t("manage.activity_older")}
              disabled={records.length === 0 || history.isFetching}
              onPress={() => setPage((p) => p + 1)}
            />
          </View>
        </>
      )}
    </QueryState>
  );
}

function Pager({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable disabled={disabled} onPress={onPress}>
      <Text
        variant='caption'
        weight='semibold'
        tone={disabled ? "disabled" : "accent"}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** NzbDrone's event names are camelCase identifiers; these are the words for them. */
function eventLabel(
  t: TFunction,
  eventType: string | null | undefined,
): string {
  switch (eventType) {
    case "grabbed":
      return t("manage.activity_event_grabbed");
    case "downloadFolderImported":
    case "movieFolderImported":
      return t("manage.activity_event_imported");
    case "downloadFailed":
      return t("manage.activity_event_download_failed");
    case "episodeFileDeleted":
    case "movieFileDeleted":
      return t("manage.activity_event_file_deleted");
    case "movieFileRenamed":
    case "episodeFileRenamed":
      return t("manage.activity_event_renamed");
    case "downloadIgnored":
      return t("manage.activity_event_ignored");
    default:
      return eventType ?? "";
  }
}

const titleOf = (t: TFunction, r: HistoryRecord): string => {
  const code =
    r.SeasonNumber != null && r.EpisodeNumber != null
      ? ` S${String(r.SeasonNumber).padStart(2, "0")}E${String(r.EpisodeNumber).padStart(2, "0")}`
      : "";
  return `${r.Title ?? r.SourceTitle ?? t("manage.activity_unknown_title")}${code}`;
};

const subtitleOf = (t: TFunction, r: HistoryRecord): string =>
  [
    eventLabel(t, r.EventType),
    r.Quality,
    r.Indexer,
    r.DownloadClient,
    r.Reason,
    arrAppLabel(t, r.App),
  ]
    .filter(Boolean)
    .join(" • ");

const isFailure = (r: HistoryRecord): boolean =>
  (r.EventType ?? "").toLowerCase().includes("failed");

function when(t: TFunction, date: string | undefined | null): string {
  if (!date) return "";
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return "";
  const ageMs = Date.now() - parsed.getTime();
  const hours = ageMs / 3_600_000;
  if (hours < 1) {
    return t("manage.activity_minutes_ago", {
      count: Math.max(1, Math.round(ageMs / 60_000)),
    });
  }
  if (hours < 24) {
    return t("manage.activity_hours_ago", { count: Math.round(hours) });
  }
  if (hours < 24 * 7) {
    return t("manage.activity_days_ago", { count: Math.round(hours / 24) });
  }
  return parsed.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}
