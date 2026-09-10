import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { toast } from "sonner-native";
import { Icon, type IconName } from "@/components/common/Icon";
import { Pill, type PillTone } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius, tokens } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useTheme } from "@/hooks/useTheme";
import { formatBytes } from "@/lib/stingstream/arr-types";
import {
  type DownloadItem,
  useDownloadAction,
  useDownloads,
  useNodeStatus,
} from "@/lib/stingstream/hooks";
import { useHealthz } from "@/lib/stingstream/status";
import { arrAppLabelWithArticle } from "../shared/arrLabels";
import { confirmDestructive } from "../shared/confirm";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { EmptyState, QueryState } from "../shared/ScreenState";

function rate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

function EngineCard({
  title,
  tone,
  state,
  detail,
}: {
  title: string;
  tone: PillTone;
  state: string;
  detail?: string;
}) {
  return (
    <View
      style={{
        flex: 1,
        borderRadius: radius.md,
        backgroundColor: tokens.color.bg["1"],
        padding: 12,
      }}
    >
      <Text weight='semibold' numberOfLines={1}>
        {title}
      </Text>
      <Pill
        label={state}
        tone={tone}
        size='sm'
        style={{ marginTop: 8, alignSelf: "flex-start" }}
      />
      {detail ? (
        <Text variant='caption' tone='secondary' style={{ marginTop: 8 }}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

export function DownloadsScreen() {
  const { t } = useTranslation();
  const status = useNodeStatus();
  const healthz = useHealthz();
  const downloads = useDownloads();
  const router = useRouter();

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
      <ScreenHeaderRow title={t("transfers.engine_health_title")} />
      <View
        testID='transfers-engine-cards'
        style={{ flexDirection: "row", gap: 12, marginBottom: 12 }}
      >
        <EngineCard
          title={t("transfers.torrent_engine")}
          tone={torrents?.Running ? "success" : "danger"}
          state={
            torrents?.Running
              ? t("transfers.engine_running")
              : t("transfers.engine_stopped")
          }
          detail={
            torrents?.Running
              ? t("transfers.torrent_engine_running", {
                  count: torrents.Count ?? 0,
                  down: rate(torrents.DownloadRate ?? 0),
                  up: rate(torrents.UploadRate ?? 0),
                })
              : undefined
          }
        />
        <EngineCard
          title={t("transfers.usenet_engine")}
          tone={
            !nzbget
              ? "neutral"
              : nzbget.state === "healthy"
                ? "success"
                : "danger"
          }
          state={
            nzbget
              ? nzbget.state
              : healthz.isLoading
                ? t("transfers.checking")
                : t("transfers.unknown")
          }
          detail={[
            nzbget?.version
              ? t("transfers.engine_version", { version: nzbget.version })
              : null,
            nzbget?.restarts
              ? t("transfers.restart_count", { count: nzbget.restarts })
              : null,
          ]
            .filter(Boolean)
            .join(" • ")}
        />
      </View>
      <ListGroup>
        <ListItem
          title={t("transfers.hashing_queue")}
          subtitle={t("transfers.hashing_queue_detail", {
            count: hashing?.Queued ?? 0,
          })}
        />
      </ListGroup>

      <View style={{ height: 16 }} />

      <ScreenHeaderRow
        title={t("transfers.title")}
        accessory={
          downloads.data ? (
            <Text variant='caption' tone='secondary'>
              {downloads.data.TotalUploadRate
                ? t("transfers.rate_down_up", {
                    down: rate(downloads.data.TotalDownloadRate ?? 0),
                    up: rate(downloads.data.TotalUploadRate),
                  })
                : t("transfers.rate_down", {
                    down: rate(downloads.data.TotalDownloadRate ?? 0),
                  })}
            </Text>
          ) : undefined
        }
      />

      <QueryState
        isLoading={downloads.isLoading}
        error={downloads.error}
        onRetry={downloads.refetch}
      >
        {items.length === 0 ? (
          <EmptyState
            title={t("transfers.empty_title")}
            detail={t("transfers.empty_detail")}
            icon='download'
            action={{
              label: t("transfers.empty_action"),
              onPress: () => router.push("/(auth)/(tabs)/(search)"),
            }}
          />
        ) : (
          <ListGroup testID='transfers-list'>
            {items.map((item) => (
              <DownloadRow key={item.Id} item={item} />
            ))}
          </ListGroup>
        )}
      </QueryState>

      {/* Only when there is a list above it: the empty state already carries this line as its
          detail, and saying it twice reads like two different problems. */}
      {items.length > 0 && downloads.data?.Engines && (
        <Text variant='caption' tone='secondary' style={{ marginTop: 8 }}>
          {engineNote(t, downloads.data.Engines)}
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
  t: TFunction,
  engines: Record<string, string>,
): string | undefined {
  const bad = Object.entries(engines).filter(([, v]) => v !== "ok");
  if (bad.length === 0) {
    return t("transfers.engines_reporting", {
      engines: Object.keys(engines).join(", "),
    });
  }
  return t("transfers.engines_not_reporting", {
    engines: bad.map(([k, v]) => `${k} (${v})`).join(", "),
  });
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const { t } = useTranslation();
  const action = useDownloadAction();

  const run = async (
    kind: "pause" | "resume" | "remove",
    deleteFiles = false,
  ) => {
    if (kind === "remove") {
      const ok = await confirmDestructive(
        t("transfers.remove_confirm_title", { title: item.Title }),
        deleteFiles
          ? t("transfers.remove_confirm_message_files")
          : t("transfers.remove_confirm_message"),
        deleteFiles
          ? t("transfers.remove_with_files_action")
          : t("common.remove"),
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
      toast.success(result?.Message ?? t("transfers.action_done"));
    } catch (err) {
      // A 409 is the engine's honest answer ("this one tracks the download
      // rather than holding it"), not a crash, so it is shown as a message.
      toast.error(
        err instanceof Error ? err.message : t("transfers.action_refused"),
      );
    }
  };

  return (
    <View>
      <ListItem
        title={item.Title || item.Id || ""}
        subtitle={describe(t, item)}
        subtitleColor={item.State === "failed" ? "red" : "default"}
        value={percent(item)}
      />
      <View
        style={{
          backgroundColor: tokens.color.bg["2"],
          paddingHorizontal: 16,
          paddingBottom: 12,
        }}
      >
        <ProgressBar item={item} />
        <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
          {item.CanPause && (
            <IconAction
              icon='pause'
              label={t("transfers.pause_action")}
              busy={action.isPending}
              onPress={() => void run("pause")}
            />
          )}
          {item.CanResume && (
            <IconAction
              icon='play'
              label={t("transfers.resume_action")}
              busy={action.isPending}
              onPress={() => void run("resume")}
            />
          )}
          {item.CanRemove && (
            <>
              <IconAction
                icon='close'
                label={t("transfers.remove_action_for", { title: item.Title })}
                tone='red'
                busy={action.isPending}
                onPress={() => void run("remove", false)}
              />
              <IconAction
                icon='delete'
                label={t("transfers.remove_with_files_action_for", {
                  title: item.Title,
                })}
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
  const { accent } = useTheme();
  const fraction = Math.max(0, Math.min(1, item.Progress ?? 0));
  const colour =
    item.State === "failed"
      ? tokens.color.state.danger
      : item.State === "paused"
        ? tokens.color.text.tertiary
        : item.State === "completed"
          ? tokens.color.state.success
          : accent[500];
  return (
    <View
      style={{
        height: 6,
        borderRadius: radius.pill,
        overflow: "hidden",
        backgroundColor: tokens.color.bg["3"],
      }}
    >
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

function describe(t: TFunction, item: DownloadItem): string {
  const bits: string[] = [stateLabel(t, item.State)];
  if (item.SizeBytes) {
    bits.push(
      `${formatBytes(item.DownloadedBytes ?? 0)} / ${formatBytes(item.SizeBytes)}`,
    );
  }
  if (item.DownloadRate) bits.push(rate(item.DownloadRate));
  if (item.Eta) bits.push(eta(t, item.Eta));
  bits.push(engineLabel(t, item.Engine));
  if (item.App && item.App !== item.Engine) {
    bits.push(
      t("transfers.tracked_by", { app: arrAppLabelWithArticle(t, item.App) }),
    );
  }
  if (item.ErrorMessage) bits.push(item.ErrorMessage);
  return bits.filter(Boolean).join(" • ");
}

function stateLabel(t: TFunction, state: string | null | undefined): string {
  switch (state) {
    case "downloading":
      return t("transfers.state_downloading");
    case "queued":
      return t("transfers.state_queued");
    case "paused":
      return t("transfers.state_paused");
    case "stalled":
      return t("transfers.state_stalled");
    case "importing":
      return t("transfers.state_importing");
    case "completed":
      return t("transfers.state_completed");
    case "failed":
      return t("transfers.state_failed");
    default:
      return state ?? "";
  }
}

function engineLabel(t: TFunction, engine: string | null | undefined): string {
  if (engine === "torrent") return t("transfers.engine_torrent");
  if (engine === "usenet") return t("transfers.engine_usenet");
  return engine ?? "";
}

function eta(t: TFunction, seconds: number): string {
  if (seconds < 60)
    return t("transfers.eta_seconds", { count: Math.round(seconds) });
  if (seconds < 3600)
    return t("transfers.eta_minutes", { count: Math.round(seconds / 60) });
  if (seconds < 86_400)
    return t("transfers.eta_hours", { count: Math.round(seconds / 3600) });
  return t("transfers.eta_days", { count: Math.round(seconds / 86_400) });
}

/** A round icon button for a per-row transfer action — pause, resume, remove. */
function IconAction({
  icon,
  label,
  onPress,
  tone,
  busy,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tone?: "red";
  busy?: boolean;
}) {
  return (
    <Pressable
      disabled={busy}
      onPress={onPress}
      accessibilityRole='button'
      accessibilityLabel={label}
      hitSlop={6}
      style={{
        width: 40,
        height: 40,
        borderRadius: radius.sm,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tokens.color.bg["3"],
        opacity: busy ? 0.5 : 1,
      }}
    >
      <Icon
        name={icon}
        size={18}
        tone={tone === "red" ? "danger" : "primary"}
      />
    </Pressable>
  );
}
