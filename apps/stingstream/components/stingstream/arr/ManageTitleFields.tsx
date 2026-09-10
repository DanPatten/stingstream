import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { Text } from "@/components/common/Text";
import { useTheme } from "@/hooks/useTheme";
import {
  useDeleteLibraryItem,
  useUpdateLibraryItem,
} from "@/lib/stingstream/hooks";
import { confirmDestructive } from "../shared/confirm";
import { QualityProfileRow } from "./QualityProfileRow";

/**
 * What this server does about one title: keep it current, at what quality, or not at all.
 *
 * The controls only, without a dialog around them, because two screens ask the same question about
 * the same title. The details page opens them in {@link ManageTitleSheet}; a request opens them
 * inside the sheet that edits the request, where they used to be a second button called "Manage on
 * this server" sitting beside Edit and Delete. Dan, on finding all three on one row: *"what the
 * hell is manage on this server - remove that and merge that into edit."* One title, one place to
 * change it.
 *
 * Removing with files leaves a details page showing something that no longer exists, so the caller
 * is told through `onRemovedWithFiles` and navigates away. Removing without them keeps the file
 * exactly where it is; only the manager stops looking after it.
 */
export function ManageTitleFields({
  kind,
  providerId,
  title,
  monitored,
  profileName,
  active,
  onDone,
  onRemovedWithFiles,
}: {
  kind: "movie" | "series";
  providerId: number;
  title: string;
  monitored: boolean;
  /** The profile the title is on now, so the select can show it rather than only change it. */
  profileName?: string;
  /** Whether the surface holding these is on screen — gates the quality-profile lookup. */
  active: boolean;
  /** Called once a removal has happened, so the surface can close itself. */
  onDone: () => void;
  onRemovedWithFiles: () => void;
}) {
  const { t } = useTranslation();
  const { color, accent } = useTheme();
  const update = useUpdateLibraryItem(kind);
  const remove = useDeleteLibraryItem(kind);

  const toggleMonitored = async (next: boolean) => {
    try {
      await update.mutateAsync({ providerId, monitored: next });
      toast.success(
        next
          ? t("manage.monitor_started_toast", { title })
          : t("manage.monitor_stopped_toast", { title }),
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("manage.monitor_error"),
      );
    }
  };

  const del = async (deleteFiles: boolean) => {
    const ok = await confirmDestructive(
      t("manage.delete_confirm_title", { title }),
      deleteFiles
        ? t("manage.delete_confirm_message_files")
        : t("manage.delete_confirm_message"),
      deleteFiles ? t("manage.delete_with_files_action") : t("common.delete"),
    );
    if (!ok) return;
    try {
      await remove.mutateAsync({ providerId, deleteFiles });
      toast.success(t("manage.deleted_toast", { title }));
      onDone();
      if (deleteFiles) onRemovedWithFiles();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("manage.delete_error"),
      );
    }
  };

  return (
    <View testID='manage-title-sheet'>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          minHeight: 44,
          paddingVertical: 8,
        }}
      >
        <Text style={{ flex: 1, marginRight: 12 }}>
          {kind === "movie"
            ? t("manage.monitor_movie_label")
            : t("manage.monitor_series_label")}
        </Text>
        <SettingSwitch
          value={monitored}
          disabled={update.isPending}
          onValueChange={(next) => void toggleMonitored(next)}
          trackColor={{ true: accent[500] }}
        />
      </View>

      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: color.border.subtle,
          paddingTop: 8,
          marginTop: 4,
        }}
      >
        <QualityProfileRow
          kind={kind}
          providerId={providerId}
          title={title}
          profileName={profileName}
          active={active}
        />

        {/*
          Two removals, and the labels are the only thing that tells them apart, so they say what
          they do rather than both saying Delete. Dan: *"Idk what delete vs delete with files
          means."* The first stops this server looking after the title and leaves whatever is on
          disk alone; the second takes the files with it.
        */}
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 12,
          }}
        >
          <Button variant='danger' size='sm' onPress={() => void del(false)}>
            {t("manage.remove_action")}
          </Button>
          <Button
            variant='danger'
            size='sm'
            loading={remove.isPending}
            onPress={() => void del(true)}
          >
            {t("manage.delete_with_files_action")}
          </Button>
        </View>
      </View>
    </View>
  );
}
