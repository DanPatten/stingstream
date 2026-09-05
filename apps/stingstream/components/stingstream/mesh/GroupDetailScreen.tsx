import { useCallback, useMemo, useState } from "react";
import { Alert, Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import useRouter from "@/hooks/useAppRouter";
import {
  type MeshNodePeer,
  useLeaveMeshGroup,
  useNodeMeshGroups,
  useNodeMeshPeers,
  useSetGroupCoordinator,
} from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";
import { useIsStingStreamAdmin } from "../shared/RequiresAdmin";
import { QueryState } from "../shared/ScreenState";
import {
  type CoordinatorChoice,
  CoordinatorPicker,
  coordinatorChoiceReady,
  coordinatorChoiceValue,
} from "./CoordinatorPicker";
import { InviteCard } from "./InviteCard";

/**
 * One group: who is in it, how they are reached, its coordinator, and the way out.
 *
 * The member list is the **home node's** view. That is the right one to show: it is the node that
 * actually holds connections to everyone, whereas this device only dials a peer when something is
 * playing from it. Where this device *does* know better — because it is streaming from that peer
 * right now — its path is shown alongside.
 */
export function GroupDetailScreen({ group }: { group: string }) {
  const router = useRouter();
  const groups = useNodeMeshGroups();
  const peers = useNodeMeshPeers(group);
  const leave = useLeaveMeshGroup();
  const mesh = useMesh();
  const isAdmin = useIsStingStreamAdmin();
  const [showInvite, setShowInvite] = useState(false);
  const [editingCoordinator, setEditingCoordinator] = useState(false);

  const info = useMemo(
    () => (groups.data ?? []).find((g) => g.group === group),
    [groups.data, group],
  );

  const rows = useMemo(
    () =>
      [...(peers.data ?? [])].sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.nodeName.localeCompare(b.nodeName);
      }),
    [peers.data],
  );

  const onLeave = useCallback(() => {
    const run = async () => {
      try {
        await leave.mutateAsync(group);
        // The embedded node follows the home node, so tell it now rather than waiting for the
        // five-minute sync to notice.
        await mesh.syncGroups();
        toast.success("Left the group");
        router.back();
      } catch (error) {
        toast.error((error as Error).message);
      }
    };

    const message =
      "This node stops gossiping, drops the shared index and forgets the group secret. " +
      "Titles held by other members disappear from your library. Rejoining needs a new invite code.";

    if (Platform.OS === "web") {
      // `Alert` on react-native-web renders nothing, so a screen that relies on it silently does
      // nothing at all when the button is pressed.
      if (
        globalThis.confirm?.(
          `Leave ${info?.name ?? "this group"}?\n\n${message}`,
        )
      ) {
        void run();
      }
      return;
    }
    Alert.alert(`Leave ${info?.name ?? "this group"}?`, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Leave", style: "destructive", onPress: () => void run() },
    ]);
  }, [group, info?.name, leave, mesh, router]);

  return (
    <QueryState
      isLoading={groups.isLoading}
      error={groups.error}
      onRetry={groups.refetch}
    >
      <ListGroup title='Group'>
        <ListItem title='Name' value={info?.name ?? "—"} />
        <ListItem title='Members' value={String(rows.length)} />
        <ListItem
          title='Online'
          value={String(rows.filter((p) => p.online).length)}
        />
        <ListItem
          title='Coordinator'
          value={info?.coordinator ? hostOf(info.coordinator) : "Default"}
          subtitle={
            info?.coordinator
              ? undefined
              : "Public infrastructure + StingStream fallback"
          }
          onPress={isAdmin ? () => setEditingCoordinator((v) => !v) : undefined}
          showArrow={isAdmin}
        />
      </ListGroup>

      {editingCoordinator && (
        <ChangeCoordinator
          group={group}
          current={info?.coordinator ?? null}
          onDone={() => setEditingCoordinator(false)}
        />
      )}

      <View className='h-4' />

      <ListGroup
        title='Members'
        description={
          <Text className='text-[#9899A1] text-xs'>
            "Direct" means bytes travel peer to peer; "relayed" means they pass
            through a relay, which still works but costs someone bandwidth. A
            member with no path yet is simply one nothing has been asked of.
          </Text>
        }
      >
        {rows.map((peer) => (
          <ListItem
            key={peer.node}
            title={peer.nodeName || shorten(peer.node)}
            subtitle={describePeer(peer)}
            subtitleColor={peer.online ? "default" : "red"}
            value={peer.online ? pathLabel(peer.path) : "Offline"}
          />
        ))}
        {rows.length === 0 && (
          <ListItem
            title='No members yet'
            subtitle='Share an invite code to add one.'
          />
        )}
      </ListGroup>

      <View className='h-4' />

      {/* Minting an invite and leaving are both RequiresElevation on the node — a group is the
          node's identity in the mesh, not a per-user setting — so a non-administrator sees the
          group and its members and nothing that would answer 403. */}
      {isAdmin ? (
        <>
          {showInvite ? (
            <InviteCard group={group} groupName={info?.name ?? ""} />
          ) : (
            <Button color='black' onPress={() => setShowInvite(true)}>
              Show invite code
            </Button>
          )}

          <View className='h-6' />

          <Button
            color='red'
            variant='border'
            onPress={onLeave}
            loading={leave.isPending}
          >
            Leave group
          </Button>
        </>
      ) : (
        <Text className='text-[#9899A1] text-xs'>
          Inviting and leaving are administrator actions on this node.
        </Text>
      )}
    </QueryState>
  );
}

/**
 * Change the group's coordinator, with the same live check the create screen uses.
 *
 * The warning is the point of the screen. Changing a coordinator is not like changing a setting on
 * this node: it reaches every member through gossip, and a member that is offline right now adopts
 * it when it comes back. So the copy says who it affects and when, and the destructive-sounding
 * half — "Use the default" — says what a group without a coordinator loses (rendezvous, the TCP-443
 * relay, the HTTPS side door) rather than presenting it as simply turning something off.
 */
function ChangeCoordinator({
  group,
  current,
  onDone,
}: {
  group: string;
  current: string | null;
  onDone: () => void;
}) {
  const [choice, setChoice] = useState<CoordinatorChoice>(
    current ? { kind: "custom", url: current } : { kind: "default" },
  );
  const setCoordinator = useSetGroupCoordinator();

  const next = coordinatorChoiceValue(choice);
  const unchanged = (next ?? null) === (current ?? null);

  const save = async () => {
    try {
      await setCoordinator.mutateAsync({ group, coordinator: next });
      toast.success(
        next
          ? `Coordinator set to ${hostOf(next)}. Every member follows.`
          : "Back to public infrastructure. Every member follows.",
      );
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <View className='mt-3'>
      <CoordinatorPicker
        value={choice}
        onChange={setChoice}
        disabled={setCoordinator.isPending}
      />
      <Text className='text-[#9899A1] text-xs mt-3'>
        The change is gossiped to the whole group, signed by this node. Members
        that are offline adopt it when they return, and invite codes minted
        afterwards carry it — codes already handed out still work.
      </Text>
      <View className='h-3' />
      <Button
        color='purple'
        disabled={
          unchanged ||
          !coordinatorChoiceReady(choice) ||
          setCoordinator.isPending
        }
        loading={setCoordinator.isPending}
        onPress={() => void save()}
      >
        {unchanged ? "No change" : "Change coordinator"}
      </Button>
      <View className='h-2' />
      <Button color='black' onPress={onDone}>
        Cancel
      </Button>
    </View>
  );
}

const describePeer = (peer: MeshNodePeer): string => {
  const bits: string[] = [];
  if (peer.rttMs != null) bits.push(`${peer.rttMs} ms`);
  if (peer.freeSpace) bits.push(`${gib(peer.freeSpace)} free`);
  bits.push(shorten(peer.node));
  return bits.join(" • ");
};

const pathLabel = (path: string | null | undefined): string => {
  switch (path) {
    case "direct":
    case "mixed":
      return "Direct";
    case "relay":
      return "Relayed";
    default:
      return "Online";
  }
};

const shorten = (nodeId: string): string =>
  nodeId.length > 16 ? `${nodeId.slice(0, 12)}…` : nodeId;

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(0)} GB`;

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
