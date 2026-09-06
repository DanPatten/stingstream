import { TouchableOpacity, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { formatBytes } from "@/lib/stingstream/arr-types";
import {
  type DownloadItem,
  useDownloadAction,
  useDownloads,
  useNodeStatus,
} from "@/lib/stingstream/hooks";
import { useHealthz } from "@/lib/stingstream/status";
import { confirmDestructive } from "../shared/confirm";
import { EmptyState, QueryState } from "../shared/ScreenState";

function rate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function DownloadsScreen() {
  const status = useNodeStatus();
  const healthz = useHealthz();
  const downloads = useDownloads();

  const nzbget = healthz.data?.children.find((c) => c.name === "nzbget");
  const torrents = status.data?.Torrents;
  const hashing = status.data?.Hashing;
  const items = downloads.data?.Items ?? [];

  return (
    <QueryState
      isLoading={status.isLoading}
      error={status.error}
      onRetry={status.refetch}
    >
      <Text className='text-white text-lg font-semibold mb-2'>
        Engine health
      </Text>
      <ListGroup>
        <ListItem
          title='Torrent engine'
          subtitle={
            torrents?.Running
              ? `Running • ${torrents.Count ?? 0} active • ${rate(torrents.DownloadRate ?? 0)} down / ${rate(torrents.UploadRate ?? 0)} up`
              : "Stopped"
          }
          textColor={torrents?.Running ? "default" : "red"}
        />
        <ListItem
          title='Usenet engine'
          subtitle={
            nzbget
              ? `${nzbget.state}${nzbget.restarts ? ` • ${nzbget.restarts} restart(s)` : ""}`
              : healthz.isLoading
                ? "Checking…"
                : "Unknown"
          }
          textColor={nzbget?.state === "healthy" ? "default" : "red"}
        />
        <ListItem
          title='Hashing queue'
          subtitle={`${hashing?.Queued ?? 0} file(s) queued for BLAKE3 hashing`}
        />
      </ListGroup>

      <View className='h-4' />

      <View className='flex-row items-baseline justify-between mb-2'>
        <Text className='text-white text-lg font-semibold'>Downloads</Text>
        {downloads.data && (
          <Text className='text-[#9899A1] text-xs'>
            {rate(downloads.data.TotalDownloadRate ?? 0)} down
            {downloads.data.TotalUploadRate
              ? ` / ${rate(downloads.data.TotalUploadRate)} up`
              : ""}
          </Text>
        )}
      </View>

      <QueryState
        isLoading={downloads.isLoading}
        error={downloads.error}
        onRetry={downloads.refetch}
      >
        {items.length === 0 ? (
          <EmptyState
            title='Nothing downloading'
            detail={engineNote(downloads.data?.Engines)}
          />
        ) : (
          <ListGroup>
            {items.map((item) => (
              <DownloadRow key={item.Id} item={item} />
            ))}
          </ListGroup>
        )}
      </QueryState>

      {/* Only when there is a list above it: the empty state already carries this line as its
          detail, and saying it twice reads like two different problems. */}
      {items.length > 0 && downloads.data?.Engines && (
        <Text className='text-[#9899A1] text-xs mt-2'>
          {engineNote(downloads.data.Engines)}
        </Text>
      )}
    </QueryState>
  );
}

/**
 * Which engines answered, spelled out.
 *
 * An empty list means one of two completely different things — nothing is
 * downloading, or the engine that would have said so is down — and a screen that
 * cannot tell them apart sends somebody looking for a bug that is not there.
 */
function engineNote(
  engines: Record<string, string> | undefined,
): string | undefined {
  if (!engines) return undefined;
  const bad = Object.entries(engines).filter(([, v]) => v !== "ok");
  if (bad.length === 0) {
    return `Reporting: ${Object.keys(engines).join(", ")}.`;
  }
  return `Not reporting: ${bad.map(([k, v]) => `${k} (${v})`).join(", ")}.`;
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const action = useDownloadAction();

  const run = async (
    kind: "pause" | "resume" | "remove",
    deleteFiles = false,
  ) => {
    if (kind === "remove") {
      const ok = await confirmDestructive(
        `Remove ${item.Title}?`,
        deleteFiles
          ? "The download is cancelled and what has been fetched so far is deleted."
          : "The download is cancelled. Files already fetched are left on disk.",
        deleteFiles ? "Remove and delete" : "Remove",
      );
      if (!ok) return;
    }
    try {
      const result = await action.mutateAsync({
        action: kind,
        engine: item.Engine ?? "",
        id: item.EngineId ?? "",
        deleteFiles,
      });
      toast.success(result?.Message ?? "Done");
    } catch (err) {
      // A 409 is the engine's honest answer ("this one tracks the download
      // rather than holding it"), not a crash, so it is shown as a message.
      toast.error(err instanceof Error ? err.message : "The engine refused");
    }
  };

  return (
    <View>
      <ListItem
        title={item.Title || item.Id || ""}
        subtitle={describe(item)}
        subtitleColor={item.State === "failed" ? "red" : "default"}
        value={percent(item)}
      />
      <View className='bg-neutral-900 px-4 pb-3'>
        <ProgressBar item={item} />
        <View className='flex-row gap-2 mt-2'>
          {item.CanPause && (
            <RowAction
              label='Pause'
              busy={action.isPending}
              onPress={() => void run("pause")}
            />
          )}
          {item.CanResume && (
            <RowAction
              label='Resume'
              busy={action.isPending}
              onPress={() => void run("resume")}
            />
          )}
          {item.CanRemove && (
            <>
              <RowAction
                label='Remove'
                tone='red'
                busy={action.isPending}
                onPress={() => void run("remove", false)}
              />
              <RowAction
                label='Remove + files'
                tone='red'
                busy={action.isPending}
                onPress={() => void run("remove", true)}
              />
            </>
          )}
        </View>
      </View>
    </View>
  );
}

function ProgressBar({ item }: { item: DownloadItem }) {
  const fraction = Math.max(0, Math.min(1, item.Progress ?? 0));
  const colour =
    item.State === "failed"
      ? "#b91c1c"
      : item.State === "paused"
        ? "#6b7280"
        : item.State === "completed"
          ? "#16a34a"
          : "#0584FE";
  return (
    <View className='h-1.5 rounded-full overflow-hidden bg-neutral-800'>
      <View
        style={{
          width: `${fraction * 100}%`,
          height: "100%",
          backgroundColor: colour,
        }}
      />
    </View>
  );
}

const percent = (item: DownloadItem): string =>
  item.Progress == null ? "—" : `${Math.round(item.Progress * 100)}%`;

function describe(item: DownloadItem): string {
  const bits: string[] = [STATES[item.State ?? ""] ?? item.State ?? ""];
  if (item.SizeBytes) {
    bits.push(
      `${formatBytes(item.DownloadedBytes ?? 0)} / ${formatBytes(item.SizeBytes)}`,
    );
  }
  if (item.DownloadRate) bits.push(rate(item.DownloadRate));
  if (item.Eta) bits.push(eta(item.Eta));
  bits.push(ENGINES[item.Engine ?? ""] ?? item.Engine ?? "");
  if (item.App && item.App !== item.Engine) bits.push(`for ${item.App}`);
  if (item.ErrorMessage) bits.push(item.ErrorMessage);
  return bits.filter(Boolean).join(" • ");
}

const STATES: Record<string, string> = {
  downloading: "Downloading",
  queued: "Queued",
  paused: "Paused",
  stalled: "Stalled",
  importing: "Importing",
  completed: "Completed",
  failed: "Failed",
};

const ENGINES: Record<string, string> = {
  torrent: "torrent",
  usenet: "usenet",
  radarr: "tracked by the movie manager",
  sonarr: "tracked by the series manager",
};

function eta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m left`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h left`;
  return `${Math.round(seconds / 86_400)}d left`;
}

function RowAction({
  label,
  onPress,
  tone,
  busy,
}: {
  label: string;
  onPress: () => void;
  tone?: "red";
  busy?: boolean;
}) {
  return (
    <TouchableOpacity
      disabled={busy}
      onPress={onPress}
      className='rounded-lg px-3 py-1.5'
      style={{
        backgroundColor: tone === "red" ? "#3f1d1d" : "#2a2a2a",
        opacity: busy ? 0.5 : 1,
      }}
    >
      <Text
        className={
          tone === "red" ? "text-red-400 text-xs" : "text-white text-xs"
        }
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}
