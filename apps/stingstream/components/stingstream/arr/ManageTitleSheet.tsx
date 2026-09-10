import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { SkeletonText } from "@/components/common/Skeleton";
import { Text } from "@/components/common/Text";
import { useTheme } from "@/hooks/useTheme";
import {
  useDeleteLibraryItem,
  useQualityProfiles,
  useUpdateLibraryItem,
} from "@/lib/stingstream/hooks";
import { confirmDestructive } from "../shared/confirm";

/**
 * What this server does about one title: keep it current, at what quality, or not at all.
 *
 * These three lived on a settings screen listing every title the managers tracked, alongside a
 * search-and-add form. The form was a second Requests — the same lookup, the same add, without the
 * group dedupe or the approval — so it went, and these came here, to the title they are about. A
 * person removing a film looks at the film.
 *
 * Opened from the details page's overflow menu, and only when `useArrTitle` found a row: on a
 * pooled library most of what is on screen is held by somebody else's node and tracked by no
 * manager here, and a control that can only fail is worse than no control.
 *
 * Removing with files leaves the page showing something that no longer exists, so the caller is
 * told and navigates away. Removing without them keeps the film exactly where it is; only the
 * manager stops looking after it.
 */
export function ManageTitleSheet({
  kind,
  providerId,
  title,
  monitored,
  visible,
  onClose,
  onRemovedWithFiles,
}: {
  kind: "movie" | "series";
  providerId: number;
  title: string;
  monitored: boolean;
  visible: boolean;
  onClose: () => void;
  onRemovedWithFiles: () => void;
}) {
  const { t } = useTranslation();
  const { color, accent } = useTheme();
  const update = useUpdateLibraryItem(kind);
  const remove = useDeleteLibraryItem(kind);
  const profiles = useQualityProfiles(visible);
  const [showProfiles, setShowProfiles] = useState(false);

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

  const setProfile = async (name: string) => {
    try {
      await update.mutateAsync({ providerId, qualityProfileName: name });
      toast.success(t("manage.profile_set_toast", { title, profile: name }));
      setShowProfiles(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("manage.profile_error"),
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
      onClose();
      if (deleteFiles) onRemovedWithFiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("manage.delete_error"));
    }
  };

  return (
    <Dialog visible={visible} onClose={onClose} title={title}>
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
            paddingTop: 12,
            marginTop: 4,
          }}
        >
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button
              variant='secondary'
              size='sm'
              onPress={() => setShowProfiles((v) => !v)}
            >
              {t("manage.quality_profile_action")}
            </Button>
            <Button variant='danger' size='sm' onPress={() => void del(false)}>
              {t("common.delete")}
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

          {showProfiles && (
            <View style={{ marginTop: 12 }}>
              {profiles.isLoading && (
                <SkeletonText lines={2} lastLineWidth='40%' />
              )}
              {(profiles.data ?? []).map((p) => (
                <Pressable
                  key={p.Name}
                  onPress={() => void setProfile(p.Name ?? "")}
                  style={{ paddingVertical: 8 }}
                >
                  <Text tone='accent' weight='semibold'>
                    {p.Name}
                    {p.InSync === false ? t("manage.out_of_sync_suffix") : ""}
                  </Text>
                </Pressable>
              ))}
              {profiles.data?.length === 0 && (
                <Text variant='caption' tone='secondary'>
                  {t("manage.no_profiles_hint")}
                </Text>
              )}
            </View>
          )}
        </View>
      </View>
    </Dialog>
  );
}
