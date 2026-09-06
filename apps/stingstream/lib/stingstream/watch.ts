import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { apiAtom } from "@/providers/JellyfinProvider";
import {
  fetchWatchSession,
  fetchWatchSessions,
  joinWatchSession,
  leaveWatchSession,
  startWatchSession,
} from "./watchApi";

/**
 * React Query over `/stingstream/api/v1/watch/*` (M7) — watch together **across nodes**.
 *
 * Watching with somebody on your own node needs none of this: Jellyfin's own SyncPlay already does
 * it, and a peer's `.strm` is an ordinary library item to it. See `./watchApi` for the rest of that
 * argument, the types, and every pure function worth asserting.
 */

export * from "./watchApi";

const keys = {
  all: ["stingstream", "watch"] as const,
  list: (group: string | null | undefined) =>
    ["stingstream", "watch", "list", group ?? null] as const,
  detail: (id: string) => ["stingstream", "watch", "detail", id] as const,
};

/** The node's StingStream API root and the token, or nulls before a server is connected. */
function useConnection() {
  const api = useAtomValue(apiAtom);
  const base = api?.basePath ? getStingStreamApiBaseUrl(api.basePath) : null;
  return { base, token: api?.accessToken ?? null };
}

/**
 * Every open watch session in the group.
 *
 * Polled rather than pushed. A session is announced over gossip, which converges in seconds, and
 * the app has no channel to the mesh of its own — so a poll on the same order as gossip's own tick
 * is both the honest interval and the simplest thing that works. It costs one loopback request
 * against the home node, which is already answering several a second while anything is playing.
 */
export function useWatchSessions(group?: string | null) {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.list(group),
    // **Only with a group.** Core answers 409 to a group-less list — a node in
    // none has nothing to be invited to, and a node in several is being asked
    // to guess — and the browser logs every 409 as a console error, so the
    // banner was printing two of them on every screen the app has (pass-02
    // F-23) to learn something it already knew from `useNodeMeshGroups`.
    enabled: Boolean(base) && Boolean(group),
    refetchInterval: 15_000,
    queryFn: () => fetchWatchSessions(base as string, token, group ?? null),
    // An invite that never arrives is a feature that does not exist, but a node whose mesh is
    // restarting must not put a red banner in front of somebody trying to watch a film. It answers
    // with an error here, and that is simply "no invites".
    retry: false,
  });
}

/**
 * One session, and where it is right now.
 *
 * Polled faster than the list, because this is what the "in sync" pill reads: a room that has
 * drifted should say so while it is still drifting, not a quarter of a minute later.
 */
export function useWatchSession(sessionId: string | null | undefined) {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.detail(sessionId ?? ""),
    enabled: Boolean(base && sessionId),
    refetchInterval: 3_000,
    queryFn: () =>
      fetchWatchSession(base as string, sessionId as string, token),
    retry: false,
  });
}

/** Start a session for an item, with this node leading it. */
export function useStartWatchSession() {
  const { base, token } = useConnection();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      itemId,
      group,
    }: {
      itemId: string;
      group?: string | null;
    }) => startWatchSession(base as string, itemId, token, group ?? null),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.all }),
  });
}

/** Join a session another node leads. */
export function useJoinWatchSession() {
  const { base, token } = useConnection();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      sessionId,
      group,
    }: {
      sessionId: string;
      group?: string | null;
    }) => joinWatchSession(base as string, sessionId, token, group ?? null),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.all }),
  });
}

/** Leave a session. If this node leads it, this ends it for everybody. */
export function useLeaveWatchSession() {
  const { base, token } = useConnection();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      leaveWatchSession(base as string, sessionId, token),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.all }),
  });
}
