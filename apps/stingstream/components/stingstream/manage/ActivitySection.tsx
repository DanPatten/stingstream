import { useState } from "react";
import { TouchableOpacity, View } from "react-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import type { ArrQueueItem } from "@/lib/stingstream/arr-types";
import { formatBytes } from "@/lib/stingstream/arr-types";
import {
  type HistoryRecord,
  useHistory,
  useQueue,
} from "@/lib/stingstream/hooks";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { SegmentedControl } from "../shared/SegmentedControl";

function progressLabel(item: ArrQueueItem): string {
  if (item.size && item.sizeleft != null) {
    const done = item.size - item.sizeleft;
    const pct = item.size > 0 ? Math.round((done / item.size) * 100) : 0;
    return `${pct}% • ${formatBytes(done)} / ${formatBytes(item.size)}`;
  }
  return item.trackedDownloadStatus ?? item.status ?? "";
}

function QueueList({ app, items }: { app: string; items: ArrQueueItem[] }) {
  if (items.length === 0) {
    return <EmptyState title={`Nothing in the ${app} queue`} />;
  }
  return (
    <ListGroup title={app}>
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

export function ActivitySection() {
  const [tab, setTab] = useState<"queue" | "history">("queue");
  const { data: queue, isLoading, error, refetch } = useQueue();

  return (
    <View>
      <Text className='text-white text-lg font-semibold mb-2'>Activity</Text>
      <View className='-mx-4 mb-2'>
        <SegmentedControl
          segments={[
            { key: "queue", label: "Queue" },
            { key: "history", label: "History" },
          ]}
          value={tab}
          onChange={(v) => setTab(v as "queue" | "history")}
        />
      </View>

      {tab === "queue" ? (
        <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
          <QueueList app='radarr' items={queue?.radarr ?? []} />
          <View className='h-3' />
          <QueueList app='sonarr' items={queue?.sonarr ?? []} />
        </QueryState>
      ) : (
        <HistoryList />
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
          title='No history yet'
          detail='Nothing has been grabbed or imported on this node.'
        />
      ) : (
        <>
          <ListGroup>
            {records.map((r, i) => (
              <ListItem
                key={`${r.App}-${r.Date}-${r.SourceTitle ?? r.Title}-${i}`}
                title={titleOf(r)}
                subtitle={subtitleOf(r)}
                subtitleColor={isFailure(r) ? "red" : "default"}
                value={when(r.Date)}
              />
            ))}
          </ListGroup>

          <View className='flex-row items-center justify-between mt-3'>
            <Pager
              label='← Newer'
              disabled={page <= 1 || history.isFetching}
              onPress={() => setPage((p) => Math.max(1, p - 1))}
            />
            <Text className='text-[#9899A1] text-xs'>
              Page {page}
              {history.data?.Total
                ? ` of about ${Math.max(1, Math.ceil(history.data.Total / (history.data.PageSize || 25)))}`
                : ""}
            </Text>
            <Pager
              label='Older →'
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
    <TouchableOpacity disabled={disabled} onPress={onPress}>
      <Text className={disabled ? "text-neutral-700" : "text-[#0584FE]"}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/** NzbDrone's event names are camelCase identifiers; these are the words for them. */
const EVENTS: Record<string, string> = {
  grabbed: "Grabbed",
  downloadFolderImported: "Imported",
  downloadFailed: "Download failed",
  episodeFileDeleted: "File deleted",
  movieFileDeleted: "File deleted",
  movieFileRenamed: "Renamed",
  episodeFileRenamed: "Renamed",
  downloadIgnored: "Ignored",
  movieFolderImported: "Imported",
};

const titleOf = (r: HistoryRecord): string => {
  const code =
    r.SeasonNumber != null && r.EpisodeNumber != null
      ? ` S${String(r.SeasonNumber).padStart(2, "0")}E${String(r.EpisodeNumber).padStart(2, "0")}`
      : "";
  return `${r.Title ?? r.SourceTitle ?? "Unknown"}${code}`;
};

const subtitleOf = (r: HistoryRecord): string =>
  [
    EVENTS[r.EventType ?? ""] ?? r.EventType,
    r.Quality,
    r.Indexer,
    r.DownloadClient,
    r.Reason,
    r.App,
  ]
    .filter(Boolean)
    .join(" • ");

const isFailure = (r: HistoryRecord): boolean =>
  (r.EventType ?? "").toLowerCase().includes("failed");

function when(date: string | undefined | null): string {
  if (!date) return "";
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return "";
  const ageMs = Date.now() - parsed.getTime();
  const hours = ageMs / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ageMs / 60_000))}m ago`;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  if (hours < 24 * 7) return `${Math.round(hours / 24)}d ago`;
  return parsed.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}
