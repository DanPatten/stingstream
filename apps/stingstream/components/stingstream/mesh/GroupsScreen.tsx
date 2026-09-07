import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { Icon } from "@/components/common/Icon";
import { PageContainer } from "@/components/common/PageContainer";
import { Text } from "@/components/common/Text";
import { radius, rgba, tokens } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useTheme } from "@/hooks/useTheme";
import {
  groupCounts,
  groupSyncState,
  latestPeerActivity,
  MeshUnavailableError,
  useNodeMeshGroups,
  useNodeMeshPeers,
} from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";
import { GapNotice } from "../shared/GapNotice";
import { useIsStingStreamAdmin } from "../shared/RequiresAdmin";
import { QueryState } from "../shared/ScreenState";
import { DeviceMeshSection } from "./DeviceMeshSection";
import { GroupCard } from "./GroupCard";

/**
 * The groups this server belongs to.
 *
 * The list comes from the **server**, which is where the library and the group secrets live. This
 * device's own membership follows it automatically (see `MeshProvider`), which is what each card's
 * synced/syncing pill reports. Creating and joining are elevated on the server — a group is the
 * server's identity in the mesh, not a per-user setting — so a non-administrator sees the same
 * cards with both actions disabled and a one-line reason, rather than a button that would answer
 * 403.
 */
export function GroupsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { accent } = useTheme();
  const groups = useNodeMeshGroups();
  const peers = useNodeMeshPeers(null);
  const mesh = useMesh();
  const isAdmin = useIsStingStreamAdmin();

  const joinedHere = useMemo(
    () => new Set(mesh.groups.map((g) => g.id.toLowerCase())),
    [mesh.groups],
  );

  // A server whose mesh child is down answers 503, and that is emphatically not "you belong to no
  // groups" — showing the empty state would tell the user their group had vanished. It gets its own
  // line, and this device's own status card still renders above it, because the phone's mesh is a
  // separate thing that may well be fine.
  if (groups.error instanceof MeshUnavailableError) {
    return (
      <PageContainer width='settings'>
        <DeviceMeshSection />
        <View style={{ height: 16 }} />
        <GapNotice
          title={t("sharing.mesh_unavailable_title")}
          detail={t("sharing.mesh_unavailable_detail")}
        />
      </PageContainer>
    );
  }

  const rows = groups.data ?? [];

  return (
    <PageContainer width='settings'>
      <DeviceMeshSection />
      <View style={{ height: 16 }} />

      <QueryState
        isLoading={groups.isLoading}
        error={groups.error}
        onRetry={groups.refetch}
      >
        {rows.length > 0 ? (
          <View>
            {rows.map((group) => {
              const counts = groupCounts(peers.data, group.group);
              const groupPeers = (peers.data ?? []).filter(
                (p) => p.group.toLowerCase() === group.group.toLowerCase(),
              );
              return (
                <GroupCard
                  key={group.group}
                  group={group}
                  members={counts.members}
                  online={counts.online}
                  syncState={groupSyncState(
                    mesh.available,
                    joinedHere.has(group.group.toLowerCase()),
                  )}
                  lastActiveToken={
                    latestPeerActivity(groupPeers)?.token ?? null
                  }
                  onPress={() =>
                    router.push(`/settings/groups/${group.group}/page`)
                  }
                />
              );
            })}
          </View>
        ) : (
          <View style={{ alignItems: "center", paddingVertical: 32 }}>
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 28,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: rgba(accent[500], 0.12),
                marginBottom: 16,
              }}
            >
              <Icon name='sharing' size={26} tone='accent' />
            </View>
            <Text variant='heading' weight='semibold' align='center'>
              {t("sharing.empty_title")}
            </Text>
            <Text
              variant='caption'
              tone='secondary'
              align='center'
              style={{ marginTop: 6, maxWidth: tokens.maxWidth.prose }}
            >
              {t("sharing.empty_detail")}
            </Text>
          </View>
        )}

        <View style={{ height: 16 }} />

        <SharingActions
          isAdmin={isAdmin}
          onCreate={() => router.push("/settings/groups/create/page")}
          onJoin={() => router.push("/settings/groups/join/page")}
        />

        {mesh.syncError && (
          <View
            style={{
              marginTop: 16,
              borderRadius: radius.md,
              backgroundColor: tokens.color.bg["1"],
              padding: 14,
            }}
          >
            <Text variant='body' weight='semibold' tone='danger'>
              {t("sharing.sync_error_title")}
            </Text>
            <Text variant='caption' tone='secondary' style={{ marginTop: 4 }}>
              {mesh.syncError}
            </Text>
            <Text variant='caption' tone='secondary' style={{ marginTop: 8 }}>
              {t("sharing.sync_error_detail")}
            </Text>
          </View>
        )}
      </QueryState>
    </PageContainer>
  );
}

function SharingActions({
  isAdmin,
  onCreate,
  onJoin,
}: {
  isAdmin: boolean;
  onCreate: () => void;
  onJoin: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View>
      <Button
        testID='sharing-create'
        variant='primary'
        icon='add'
        disabled={!isAdmin}
        onPress={onCreate}
      >
        {t("sharing.create_group_button")}
      </Button>
      <View style={{ height: 8 }} />
      <Button
        testID='sharing-join'
        variant='secondary'
        icon='link'
        disabled={!isAdmin}
        onPress={onJoin}
      >
        {t("sharing.join_group_button")}
      </Button>
      {!isAdmin && (
        <Text
          variant='caption'
          tone='secondary'
          align='center'
          style={{ marginTop: 8 }}
        >
          {t("sharing.admin_only_reason")}
        </Text>
      )}
    </View>
  );
}
