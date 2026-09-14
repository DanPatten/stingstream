import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { radius, space } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useRunSync, useSyncStatus } from "@/lib/stingstream/hooks";

/**
 * Says that settings on this page did not reach the movie or series manager, with a retry.
 *
 * Draws nothing otherwise. An empty status list is the normal state of a node with no indexer:
 * neither manager is started until one exists (`ArrEnablement`), so there is nothing to push into,
 * and a "Not synced" pill there read as a fault the reader had to fix. A green "Synced" on a healthy
 * node told nobody anything either. The only state worth a card is the one that needs a click.
 */
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

  if (!(statuses ?? []).some((s) => !s.Ok)) return null;

  return (
    <View
      style={{
        borderRadius: radius.lg,
        backgroundColor: color.bg["1"],
        padding: 12,
        marginBottom: space["4"],
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <View style={{ flex: 1, marginRight: 12 }}>
        <Pill
          label={t("server_settings.sync_pill_failed")}
          tone='danger'
          size='sm'
          style={{ marginBottom: 6 }}
        />
        <Text variant='caption' tone='secondary'>
          {t("server_settings.sync_some_failed")}
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
