/**
 * "Prefer" on the Playback settings page: the device's side of the source-selection argument.
 *
 * The node has a policy of its own and scores under it. This is what *this* device asks for, which
 * is the one that wins for what the chooser orders and recommends — a laptop on fibre and a tablet
 * on hotel wifi want different answers from the same library.
 */

import { Ionicons } from "@expo/vector-icons";
import type React from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { PlatformDropdown } from "@/components/PlatformDropdown";
import type { PlaybackPolicy } from "@/lib/stingstream/sourceChooser";
import { useSettings } from "@/utils/atoms/settings";

export const PlaybackPolicySetting: React.FC<{ className?: string }> = ({
  className,
}) => {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettings();

  const labels = useMemo(
    () =>
      ({
        speed_first: t("home.settings.playback_policy.speed"),
        quality_first: t("home.settings.playback_policy.quality"),
      }) satisfies Record<PlaybackPolicy, string>,
    [t],
  );

  const groups = useMemo(
    () => [
      {
        options: (["speed_first", "quality_first"] as const).map((policy) => ({
          type: "radio" as const,
          label: labels[policy],
          value: policy,
          selected: settings?.playbackPolicy === policy,
          onPress: () => updateSettings({ playbackPolicy: policy }),
        })),
      },
    ],
    [labels, settings?.playbackPolicy, updateSettings],
  );

  if (!settings) return null;

  return (
    <ListGroup
      title={t("home.settings.playback_policy.title")}
      className={className}
    >
      <ListItem
        title={t("home.settings.playback_policy.label")}
        subtitle={t("home.settings.playback_policy.description")}
      >
        <PlatformDropdown
          groups={groups}
          title={t("home.settings.playback_policy.label")}
          trigger={
            <View className='flex flex-row items-center justify-between py-1.5 pl-3'>
              <Text className='mr-1 text-[#8E8D91]'>
                {labels[settings.playbackPolicy]}
              </Text>
              <Ionicons name='chevron-expand-sharp' size={18} color='#5A5960' />
            </View>
          }
        />
      </ListItem>
    </ListGroup>
  );
};
