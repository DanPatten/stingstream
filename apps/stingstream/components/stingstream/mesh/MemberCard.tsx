import { useTranslation } from "react-i18next";
import { Platform, Pressable, View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Pill, type PillTone } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { motion, radius, rgba, tokens } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  initials,
  type MemberRow,
  pathCategory,
  rttLabel,
} from "@/lib/stingstream/mesh";

export interface MemberCardProps {
  row: MemberRow;
  name: string;
  /** Whether *this* row may be removed — `canRemoveMember(row, manageable)`, decided by the caller. */
  removable: boolean;
  onRemove?: () => void;
  disabled?: boolean;
}

/**
 * One member of a group: who they are, how they are reached, and — for an administrator — the way
 * to remove them.
 *
 * The state pill reads the same three-way split the rest of the mesh UI uses: removed first (it
 * outranks everything else, since a removed member's link details are no longer meaningful), then
 * offline, then the path. `row.isSelf` marks the **home node** answering the request, not this
 * device — see `MeshMember`'s own doc comment — so its tag is "This server", never "this device".
 */
export function MemberCard({
  row,
  name,
  removable,
  onRemove,
  disabled,
}: MemberCardProps) {
  const { t } = useTranslation();
  const { accent } = useTheme();
  const path = pathCategory(row.path);
  const rtt = rttLabel(row.rttMs);

  const online = row.online && !row.revoked;
  const tone: PillTone = row.revoked
    ? "danger"
    : !row.online
      ? "neutral"
      : path === "direct"
        ? "success"
        : path === "relayed"
          ? "info"
          : "neutral";
  const label = row.revoked
    ? t("sharing.member_removed")
    : !row.online
      ? t("sharing.member_offline")
      : path === "direct"
        ? t("sharing.member_path_direct")
        : path === "relayed"
          ? t("sharing.member_path_relayed")
          : t("sharing.member_online");

  return (
    <View
      testID='sharing-member-card'
      style={{
        flexDirection: "row",
        alignItems: "center",
        padding: 12,
        borderRadius: radius.md,
        backgroundColor: tokens.color.bg["1"],
        marginBottom: 8,
      }}
    >
      <View style={{ width: 40, height: 40 }}>
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
          <Text variant='caption' weight='semibold' tone='accent'>
            {initials(name)}
          </Text>
        </View>
        <View
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            width: 12,
            height: 12,
            borderRadius: 6,
            borderWidth: 2,
            borderColor: tokens.color.bg["1"],
            backgroundColor: online
              ? tokens.color.state.success
              : tokens.color.text.disabled,
          }}
        />
      </View>

      <View style={{ marginLeft: 12, flex: 1 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 6,
          }}
        >
          <Text variant='body' weight='semibold' numberOfLines={1}>
            {name}
          </Text>
          {row.isSelf ? (
            <Pill
              size='sm'
              tone='accent'
              label={t("sharing.member_this_server")}
            />
          ) : null}
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexWrap: "wrap",
            marginTop: 4,
            gap: 6,
          }}
        >
          <Pill size='sm' tone={tone} label={label} />
          {rtt ? (
            <Text variant='caption' tone='secondary'>
              {rtt}
            </Text>
          ) : null}
        </View>
      </View>

      {removable && onRemove ? (
        <Pressable
          accessibilityRole='button'
          accessibilityLabel={t("sharing.remove_member")}
          onPress={onRemove}
          disabled={disabled}
          hitSlop={8}
          style={[
            {
              padding: 8,
              opacity: disabled ? tokens.control.disabledOpacity : 1,
            },
            Platform.OS === "web"
              ? ({
                  cursor: disabled ? "default" : "pointer",
                  transitionDuration: `${motion.fast}ms`,
                } as object)
              : null,
          ]}
        >
          <Icon name='leave' tone='danger' size={18} />
        </Pressable>
      ) : null}
    </View>
  );
}
