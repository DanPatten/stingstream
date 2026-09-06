import { useMemo } from "react";
import { ActivityIndicator, TouchableOpacity, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useNodeMeshGroups, useNodeMeshStatus } from "@/lib/stingstream/mesh";
import {
  DRIFT_BUDGET_MS,
  invitableSession,
  isNodeInSession,
  useJoinWatchSession,
  useLeaveWatchSession,
  useWatchSessions,
  type WatchSession,
  worstDriftMs,
} from "@/lib/stingstream/watch";

/**
 * "Somebody on another node started watching something. Join?"
 *
 * Mounted app-wide next to the mini player, because an invite is not a screen anybody would think
 * to go and look at — it arrives while you are doing something else, which is the whole character
 * of being asked to watch a film with a friend.
 *
 * **It says nothing at all in the ordinary case.** No group, no session, or a session this node is
 * already in: the component renders `null` and costs one loopback poll every fifteen seconds. That
 * matters more than it sounds, because this sits above every screen in the app.
 *
 * ## What it deliberately does not do
 *
 * Watching with somebody on *your own* node needs none of this — Jellyfin's own SyncPlay covers it,
 * federated titles included, and the app's existing SyncPlay surface works on a peer's film
 * unchanged. This is only the cross-node case, so the banner is about *nodes* joining a room rather
 * than people, and joining it here is joining on behalf of everybody signed in to this node. That
 * is also why leaving says what it says when this node is the leader: ending it ends it for
 * everybody, and a button that quietly did that would be a nasty surprise.
 */
export function WatchTogetherBanner() {
  // The **home node's** identity and groups, not the phone's embedded light node's. A watch
  // session's participants are home nodes -- joining one is joining on behalf of everybody signed
  // in to that server -- so comparing against the light node's id would offer this device an invite
  // to a room its own node is already in. It is also the only pair of facts that exists on every
  // platform: the web bundle and the TV build have no embedded node at all.
  const { data: status } = useNodeMeshStatus();
  const { data: groups } = useNodeMeshGroups();
  const nodeId = status?.node ?? null;
  // The node's own group, when there is exactly one. With none there is nothing to be invited to;
  // with several, Core answers 409 rather than guessing, and so does this.
  const group = groups?.length === 1 ? groups[0].group : null;

  const { data: sessions } = useWatchSessions(group);
  const join = useJoinWatchSession();
  const leave = useLeaveWatchSession();

  const open = useMemo(() => sessions ?? [], [sessions]);
  const invite = useMemo(() => invitableSession(open, nodeId), [open, nodeId]);
  const joined = useMemo(
    () => open.find((s) => isNodeInSession(s, nodeId)) ?? null,
    [open, nodeId],
  );

  if (!group) return null;
  if (joined)
    return (
      <JoinedRow
        session={joined}
        nodeId={nodeId}
        onLeave={() => {
          leave
            .mutateAsync(joined.id)
            .then(() =>
              toast.success(
                joined.leader === nodeId
                  ? "Watch party ended for everybody"
                  : "Left the watch party",
              ),
            )
            .catch((err: unknown) =>
              toast.error(
                err instanceof Error ? err.message : "Could not leave",
              ),
            );
        }}
        pending={leave.isPending}
      />
    );

  if (!invite) return null;

  const onJoin = () => {
    join
      .mutateAsync({ sessionId: invite.id, group })
      .then(() =>
        toast.success(`Watching ${invite.title} with ${invite.leaderName}`),
      )
      .catch((err: unknown) =>
        toast.error(err instanceof Error ? err.message : "Could not join"),
      );
  };

  return (
    <View className='mx-3 mb-2 flex-row items-center justify-between rounded-xl bg-neutral-900 p-3'>
      <View className='flex-1 pr-3'>
        <Text className='text-white font-semibold' numberOfLines={1}>
          {invite.leaderName} is watching {invite.title}
        </Text>
        <Text className='text-[#9899A1] text-xs'>
          {describeParticipants(invite)}
        </Text>
      </View>
      <TouchableOpacity
        onPress={onJoin}
        disabled={join.isPending}
        accessibilityRole='button'
        accessibilityLabel={`Join ${invite.leaderName}'s watch party`}
        className='rounded-lg px-3 py-2'
        style={{ backgroundColor: Colors.primary }}
      >
        {join.isPending ? (
          <ActivityIndicator color='white' />
        ) : (
          <Text className='text-white font-semibold'>Watch together</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

/** The row shown while this node is in a session: who is in it, and how in step it is. */
function JoinedRow({
  session,
  nodeId,
  onLeave,
  pending,
}: {
  session: WatchSession;
  nodeId: string | null;
  onLeave: () => void;
  pending: boolean;
}) {
  const drift = worstDriftMs(session);
  const leading = session.leader === nodeId;

  return (
    <View className='mx-3 mb-2 flex-row items-center justify-between rounded-xl bg-neutral-900 p-3'>
      <View className='flex-1 pr-3'>
        <Text className='text-white font-semibold' numberOfLines={1}>
          Watching {session.title} together
        </Text>
        <Text className='text-[#9899A1] text-xs'>
          {describeParticipants(session)}
          {drift === null ? "" : ` · ${describeDrift(drift)}`}
        </Text>
      </View>
      <TouchableOpacity
        onPress={onLeave}
        disabled={pending}
        accessibilityRole='button'
        accessibilityLabel={
          leading ? "End the watch party" : "Leave the watch party"
        }
        className='rounded-lg border border-neutral-700 px-3 py-2'
      >
        <Text className='text-white'>{leading ? "End" : "Leave"}</Text>
      </TouchableOpacity>
    </View>
  );
}

/** "attic and loft" rather than "2 nodes". */
function describeParticipants(session: WatchSession): string {
  const names = session.participants
    .map((p) => p.nodeName || p.node.slice(0, 8))
    .filter(Boolean);
  if (names.length === 0) return session.leaderName;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * How in step the room is, in words.
 *
 * The threshold is M7's own bar. Below it the honest thing to say is "in sync" -- a number that
 * flickers between 40 and 120 milliseconds is noise being presented as information, and nobody can
 * perceive it anyway. Above it, the number is the point.
 */
function describeDrift(driftMs: number): string {
  return driftMs < DRIFT_BUDGET_MS
    ? "in sync"
    : `${(driftMs / 1000).toFixed(1)}s out of step`;
}
