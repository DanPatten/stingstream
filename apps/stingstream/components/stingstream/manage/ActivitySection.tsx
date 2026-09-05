import { useState } from "react";
import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import type { ArrQueueItem } from "@/lib/stingstream/arr-types";
import { formatBytes } from "@/lib/stingstream/arr-types";
import { useQueue } from "@/lib/stingstream/hooks";
import { GapNotice } from "../shared/GapNotice";
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
        <GapNotice
          title="History isn't available yet"
          detail="StingStream.Core only exposes the live queue right now, not a completed-grab history — see docs/UI-API-GAPS.md. Radarr's and Sonarr's own history tables already have this data."
        />
      )}
    </View>
  );
}
