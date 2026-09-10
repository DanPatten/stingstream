import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { ListItem } from "@/components/list/ListItem";
import { PlatformDropdown } from "@/components/PlatformDropdown";
import {
  useQualityProfiles,
  useUpdateLibraryItem,
} from "@/lib/stingstream/hooks";

/**
 * Which quality profile a title is on, as a select.
 *
 * Its own component because the request sheet wants this one control and none of the others in
 * {@link ManageTitleFields}. Quality is a property of what was *asked for* -- how good a copy has
 * to be before the request counts as answered -- where monitoring and removal are things done to a
 * library item, and a request is not one. Dan, on finding Remove from server on a request:
 * *"this is a request not a libary item."*
 */
export function QualityProfileRow({
  kind,
  providerId,
  title,
  profileName,
  active,
}: {
  kind: "movie" | "series";
  providerId: number;
  title: string;
  /** The profile it is on now, so the select shows it rather than only changing it. */
  profileName?: string;
  /** Whether the surface holding it is on screen -- gates the profile lookup. */
  active: boolean;
}) {
  const { t } = useTranslation();
  const update = useUpdateLibraryItem(kind);
  const profiles = useQualityProfiles(active);

  const setProfile = async (name: string) => {
    try {
      await update.mutateAsync({ providerId, qualityProfileName: name });
      toast.success(t("manage.profile_set_toast", { title, profile: name }));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("manage.profile_error"),
      );
    }
  };

  // A select, not a button that reveals a list. It answers "which profile is this on" as well as
  // "change it", which the old shape could not: the current profile was invisible until you pressed
  // something. `PlatformDropdown` is the same control the language row uses, so it is a menu on a
  // browser and a sheet on a phone without this knowing which.
  return (
    <ListItem title={t("manage.quality_profile_action")}>
      <PlatformDropdown
        title={t("manage.quality_profile_action")}
        groups={[
          {
            options: (profiles.data ?? []).map((p) => ({
              type: "radio" as const,
              label: `${p.Name}${p.InSync === false ? t("manage.out_of_sync_suffix") : ""}`,
              value: p.Name ?? "",
              selected: p.Name === profileName,
              onPress: () => void setProfile(p.Name ?? ""),
            })),
          },
        ]}
        trigger={
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingVertical: 6,
              paddingLeft: 12,
            }}
          >
            <Text tone={profileName ? "primary" : "secondary"}>
              {profiles.isLoading
                ? "…"
                : (profileName ?? t("manage.no_profiles_hint"))}
            </Text>
            <Icon name='chevronDown' size={16} tone='secondary' />
          </View>
        }
      />
    </ListItem>
  );
}
