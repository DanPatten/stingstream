import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useRunSync, useSyncStatus } from "@/lib/stingstream/hooks";
import { arrAppLabel } from "../shared/arrLabels";

/** One sentence and one pill summarising sync into the movie manager and the
 * series manager, plus a manual re-sync button. */
export function SyncStatusBanner() {
  const { color } = useTheme();
  const { t } = useTranslation();
  const { data: statuses } = useSyncStatus();
  const runSync = useRunSync();

  const onSync = async () => {
    try {
      await runSync.mutateAsync();
      toast.success(t("server_settings.sync_now_success"));
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("server_settings.sync_now_error"),
      );
    }
  };

  const failed = (statuses ?? []).filter((s) => !s.Ok);
  const summary =
    !statuses || statuses.length === 0
      ? t("server_settings.sync_not_yet")
      : failed.length === 0
        ? t("server_settings.sync_all_synced")
        : t("server_settings.sync_some_failed", {
            apps: failed.map((s) => arrAppLabel(t, s.App)).join(", "),
          });

  return (
    <View
      style={{
        borderRadius: radius.lg,
        backgroundColor: color.bg["1"],
        padding: 12,
        marginBottom: 12,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <View style={{ flex: 1, marginRight: 12 }}>
        <Pill
          label={
            !statuses || statuses.length === 0
              ? t("server_settings.sync_pill_unknown")
              : failed.length === 0
                ? t("server_settings.sync_pill_synced")
                : t("server_settings.sync_pill_failed")
          }
          tone={
            !statuses || statuses.length === 0
              ? "neutral"
              : failed.length === 0
                ? "success"
                : "danger"
          }
          size='sm'
          style={{ marginBottom: 6 }}
        />
        <Text variant='caption' tone='secondary'>
          {summary}
        </Text>
      </View>
      <Button
        variant='secondary'
        size='sm'
        loading={runSync.isPending}
        onPress={() => void onSync()}
      >
        {t("server_settings.sync_now_action")}
      </Button>
    </View>
  );
}
