import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { SectionHeader } from "@/components/common/SectionHeader";
import { Text } from "@/components/common/Text";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  type MeshNodePeer,
  memberDisplayName,
  memberRoster,
} from "@/lib/stingstream/mesh";
import { MemberCard } from "./MemberCard";

/**
 * Who is in a connection, as this server sees them: online or not, and how they are reached.
 *
 * Read-only. Removing a member and rotating the group secret are gone: a connection is removed
 * whole, from either side, and made again with a new invite. Dan: *"just delete and re-add."*
 */
export function GroupMembers({
  peers,
}: {
  peers: readonly MeshNodePeer[] | undefined;
}) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const rows = useMemo(() => memberRoster(undefined, peers), [peers]);

  return (
    <View>
      <View style={{ marginBottom: 8 }}>
        <SectionHeader title={t("sharing.members_title")} />
      </View>

      {rows.map((row) => (
        <MemberCard
          key={row.node}
          row={row}
          name={memberDisplayName(row)}
          removable={false}
        />
      ))}
      {rows.length === 0 ? (
        <View
          style={{
            padding: 16,
            borderRadius: radius.md,
            backgroundColor: color.bg["1"],
          }}
        >
          <Text variant='body' weight='semibold'>
            {t("sharing.members_empty_title")}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
