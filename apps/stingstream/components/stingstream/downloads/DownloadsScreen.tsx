import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { toast } from "sonner-native";
import { Icon, type IconName } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useTheme } from "@/hooks/useTheme";
import { formatBytes } from "@/lib/stingstream/arr-types";
import {
  type DownloadItem,
  useDownloadAction,
  useDownloads,
  useNodeStatus,
} from "@/lib/stingstream/hooks";
import { arrAppLabel } from "../shared/arrLabels";
import { confirmDestructive } from "../shared/confirm";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { EmptyState, QueryState } from "../shared/ScreenState";

function rate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function DownloadsScreen() {
  const { t } = useTranslation();
  const status = useNodeStatus();
  const downloads = useDownloads();
  const router = useRouter();

  const hashing = status.data?.Hashing;
  const items = downloads.data?.Items ?? [];

  return (
    <QueryState
      isLoading={status.isLoading}
      error={status.error}
      onRetry={status.refetch}
    >
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

      <View style={{ height: 16 }} />
      <ListGroup>
        <ListItem
          title={t("transfers.hashing_queue")}
          subtitle={t("transfers.hashing_queue_detail", {
            count: hashing?.Queued ?? 0,
          })}
        />
      </ListGroup>
    </QueryState>
  );
}

/**
 * Which queues answered, spelled out.
 *
 * An empty list means one of two completely different things — nothing is
 * downloading, or the queue that would have said so is down — and a screen that
 * cannot tell them apart sends somebody looking for a bug that is not there.
 * The keys are the managers' own names, so they are shown as Movies and TV shows.
 */
function engineNote(
  t: TFunction,
  engines: Record<string, string>,
): string | undefined {
  const bad = Object.entries(engines).filter(([, v]) => v !== "ok");
  if (bad.length === 0) {
    return t("transfers.engines_reporting", {
      engines: Object.keys(engines)
        .map((k) => arrAppLabel(t, k))
        .join(", "),
    });
  }
  return t("transfers.engines_not_reporting", {
    engines: bad.map(([k]) => arrAppLabel(t, k)).join(", "),
  });
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const action = useDownloadAction();

  const remove = async (deleteFiles: boolean) => {
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
    try {
      const result = await action.mutateAsync({
        engine: item.Engine ?? "",
        id: item.EngineId ?? "",
        deleteFiles,
      });
      toast.success(result?.Message ?? t("transfers.action_done"));
    } catch (err) {
      // A 409 is the server's honest answer ("that download is gone"), not a
      // crash, so it is shown as a message.
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
          backgroundColor: color.bg["2"],
          paddingHorizontal: 16,
          paddingBottom: 12,
        }}
      >
        <ProgressBar item={item} />
        <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
          {item.CanRemove && (
            <>
              <IconAction
                icon='close'
                label={t("transfers.remove_action_for", { title: item.Title })}
                tone='red'
                busy={action.isPending}
                onPress={() => void remove(false)}
              />
              <IconAction
                icon='delete'
                label={t("transfers.remove_with_files_action_for", {
                  title: item.Title,
                })}
                tone='red'
                busy={action.isPending}
                onPress={() => void remove(true)}
              />
            </>
          )}
        </View>
      </View>
    </View>
  );
}

function ProgressBar({ item }: { item: DownloadItem }) {
  const { color, accent } = useTheme();
  const fraction = Math.max(0, Math.min(1, item.Progress ?? 0));
  const fill =
    item.State === "failed"
      ? color.state.danger
      : item.State === "paused"
        ? color.text.tertiary
        : item.State === "completed"
          ? color.state.success
          : accent[500];
  return (
    <View
      style={{
        height: 6,
        borderRadius: radius.pill,
        overflow: "hidden",
        backgroundColor: color.bg["3"],
      }}
    >
      <View
        style={{
          width: `${fraction * 100}%`,
          height: "100%",
          backgroundColor: fill,
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
  bits.push(arrAppLabel(t, item.App ?? item.Engine));
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

function eta(t: TFunction, seconds: number): string {
  if (seconds < 60)
    return t("transfers.eta_seconds", { count: Math.round(seconds) });
  if (seconds < 3600)
    return t("transfers.eta_minutes", { count: Math.round(seconds / 60) });
  if (seconds < 86_400)
    return t("transfers.eta_hours", { count: Math.round(seconds / 3600) });
  return t("transfers.eta_days", { count: Math.round(seconds / 86_400) });
}

/** A round icon button for a per-row transfer action. */
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
  const { color } = useTheme();
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
        backgroundColor: color.bg["3"],
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
