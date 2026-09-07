import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { motion, radius, rgba, tokens } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import type { GroupSyncState, MeshNodeGroup } from "@/lib/stingstream/mesh";

export interface GroupCardProps {
  group: MeshNodeGroup;
  members: number;
  online: number;
  syncState: GroupSyncState;
  /** A compact `4m`/`3h`/`2d` from {@link latestPeerActivity}, or null when nothing has been seen. */
  lastActiveToken: string | null;
  onPress: () => void;
}

/**
 * One row of the Sharing screen's group list: the name, who is in it and whether it has caught up
 * on this device.
 *
 * "Syncing" is not a warning — a group the home node just created or joined has not reached the
 * app's own light node yet, which follows on a timer — so it gets the same tinted `Pill` treatment
 * as "Synced" rather than a warning colour.
 */
export function GroupCard({
  group,
  members,
  online,
  syncState,
  lastActiveToken,
  onPress,
}: GroupCardProps) {
  const { t } = useTranslation();
  const { accent } = useTheme();
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      testID='sharing-group-card'
      accessibilityRole='button'
      accessibilityLabel={group.name || t("sharing.unnamed_group")}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          padding: 14,
          borderRadius: radius.md,
          backgroundColor: hovered
            ? tokens.color.bg["2"]
            : tokens.color.bg["1"],
          marginBottom: 8,
        },
        Platform.OS === "web"
          ? ({
              cursor: "pointer",
              transitionDuration: `${motion.fast}ms`,
            } as object)
          : null,
      ]}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: rgba(accent[500], 0.16),
        }}
      >
        <Icon name='sharing' tone='accent' size={20} />
      </View>

      <View style={{ marginLeft: 12, flex: 1 }}>
        <Text variant='body' weight='semibold' numberOfLines={1}>
          {group.name || t("sharing.unnamed_group")}
        </Text>

        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            marginTop: 6,
            gap: 6,
          }}
        >
          <Pill
            size='sm'
            label={t("sharing.member_count", { count: members })}
          />
          <Pill
            size='sm'
            tone={online > 0 ? "success" : "neutral"}
            label={t("sharing.online_count", { count: online })}
          />
          <Pill
            size='sm'
            tone={syncState === "syncing" ? "info" : "success"}
            icon={syncState === "syncing" ? "refresh" : "check"}
            label={
              syncState === "syncing"
                ? t("sharing.state_syncing")
                : t("sharing.state_synced")
            }
          />
        </View>

        {lastActiveToken ? (
          <Text variant='micro' tone='tertiary' style={{ marginTop: 4 }}>
            {t("sharing.last_active", { when: lastActiveToken })}
          </Text>
        ) : null}
      </View>

      <Icon name='chevronRight' size={18} tone='tertiary' />
    </Pressable>
  );
}
