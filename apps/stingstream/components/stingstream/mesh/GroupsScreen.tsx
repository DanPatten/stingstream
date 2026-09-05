import { useMemo } from "react";
import { Platform, View } from "react-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import useRouter from "@/hooks/useAppRouter";
import {
  MeshUnavailableError,
  useNodeMeshGroups,
  useNodeMeshPeers,
} from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";
import { GapNotice } from "../shared/GapNotice";
import { useIsStingStreamAdmin } from "../shared/RequiresAdmin";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { DeviceMeshSection } from "./DeviceMeshSection";

/**
 * The groups this node belongs to.
 *
 * The list comes from the **home node**, which is where the library and the group secrets live.
 * This device's own membership follows it automatically (see `MeshProvider`), and the pill on
 * each row says whether the phone has caught up — a group the node joined a moment ago will show
 * "syncing" until the next membership sync.
 */
export function GroupsScreen() {
  const router = useRouter();
  const groups = useNodeMeshGroups();
  const peers = useNodeMeshPeers(null);
  const mesh = useMesh();
  const isAdmin = useIsStingStreamAdmin();

  const joinedHere = useMemo(
    () => new Set(mesh.groups.map((g) => g.id.toLowerCase())),
    [mesh.groups],
  );

  const countsFor = (group: string) => {
    const rows = (peers.data ?? []).filter((p) => p.group === group);
    return {
      members: rows.length,
      online: rows.filter((p) => p.online).length,
    };
  };

  // A node whose mesh child is down answers 503, and that is emphatically not "you belong to no
  // groups" — showing the empty state would tell the user their group had vanished. It gets its
  // own line, and this device's own section still renders below it, because the phone's mesh is
  // a separate thing that may well be fine.
  if (groups.error instanceof MeshUnavailableError) {
    return (
      <>
        <DeviceMeshSection />
        <View className='h-4' />
        <GapNotice
          title="This node's mesh isn't answering"
          detail={groups.error.message}
        />
      </>
    );
  }

  return (
    <QueryState
      isLoading={groups.isLoading}
      error={groups.error}
      onRetry={groups.refetch}
    >
      <DeviceMeshSection />

      <View className='h-4' />

      <ListGroup title='Groups'>
        {(groups.data ?? []).map((group) => {
          const { members, online } = countsFor(group.group);
          return (
            <ListItem
              key={group.group}
              title={group.name || "Unnamed group"}
              subtitle={[
                `${members} member${members === 1 ? "" : "s"}`,
                `${online} online`,
                group.coordinator ? "own coordinator" : "no coordinator",
                mesh.available && !joinedHere.has(group.group.toLowerCase())
                  ? "syncing to this device"
                  : null,
              ]
                .filter(Boolean)
                .join(" • ")}
              showArrow
              onPress={() =>
                router.push(`/settings/groups/${group.group}/page`)
              }
            />
          );
        })}
        {(groups.data ?? []).length === 0 && (
          <ListItem
            title='No groups yet'
            subtitle='Create one, or join a friend’s with their invite code.'
          />
        )}
      </ListGroup>

      <View className='h-4' />

      {/* Both are RequiresElevation on the node: a group is the node's identity in the mesh,
          not a per-user setting. */}
      {isAdmin ? (
        <ListGroup>
          <ListItem
            title='Create group'
            textColor='blue'
            showArrow
            onPress={() => router.push("/settings/groups/create/page")}
          />
          <ListItem
            title='Join group'
            subtitle={
              Platform.isTV
                ? "Enter an invite code"
                : "Paste an invite code, or scan a QR"
            }
            textColor='blue'
            showArrow
            onPress={() => router.push("/settings/groups/join/page")}
          />
        </ListGroup>
      ) : (
        <ListGroup
          description={
            <Text className='text-[#9899A1] text-xs'>
              Creating and joining groups are administrator actions on your home
              node. Your device already follows whichever groups it belongs to.
            </Text>
          }
        >
          <ListItem title='Managed by an administrator' />
        </ListGroup>
      )}

      {mesh.syncError && (
        <View className='mt-4 rounded-xl bg-neutral-900 p-4'>
          <Text className='text-red-500 font-semibold'>
            This device could not join every group
          </Text>
          <Text className='text-[#9899A1] text-xs mt-1'>{mesh.syncError}</Text>
          <Text className='text-[#9899A1] text-xs mt-2'>
            Playback still works — the home node proxies the stream instead.
          </Text>
        </View>
      )}

      {(groups.data ?? []).length === 0 && !groups.isLoading && (
        <View className='mt-4'>
          <EmptyState
            title='Nothing is shared yet'
            detail='A group is a set of nodes that pool their libraries. Nothing leaves a group, and there is no directory — the only way in is an invite code.'
          />
        </View>
      )}
    </QueryState>
  );
}
