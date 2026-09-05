import type { paths } from "@stingstream/api-client";
import { authHeaders, both, field, readError } from "./meshApi";

/**
 * The plain-fetch half of watch-together across nodes â€” `/stingstream/api/v1/watch/*`,
 * `StingStream.Core`'s `WatchController` (M7).
 *
 * ## What this is *not* for
 *
 * **Watching together with somebody on your own node needs none of it.** Jellyfin's own SyncPlay
 * already synchronises two people signed in to the same server, and a federated title is an
 * ordinary library item to it â€” a `.strm` whose bytes happen to come off somebody else's disk â€” so
 * the SyncPlay UI works on a peer's film unchanged. This is only for the case Jellyfin cannot
 * reach: two friends on two different nodes, whose servers have no session in common.
 *
 * ## The shape that follows from that
 *
 * A session is created on the node whose user started it and *joined* by every other node, each of
 * which runs its own local SyncPlay group underneath. So a member calls {@link startWatchSession}
 * once, their friends call {@link joinWatchSession}, and from then on everybody uses the player
 * they already had. Nothing here streams, seeks or plays; it arranges who is in the room.
 *
 * Split from the hooks for the same reason `meshApi.ts` is split from `mesh.ts`: nothing here
 * imports React or `providers/JellyfinProvider`, so `bun:test` can load it directly. All of the
 * shaping lives on this side of that line.
 *
 * ## Casing
 *
 * Core answers **PascalCase** (`docs/APP-MESH.md` Â§6), so every reader accepts both spellings
 * through `field(raw, ...both("x"))` and `watchApi.test.ts` asserts the two round-trip identically.
 *
 * The *routes* are pinned to the generated document by [`ROUTES`], the same way `requestsApi.ts`
 * pins its own: the response shapes stay hand-written (the generated ones are PascalCase because
 * Swashbuckle reads Jellyfin's serializer options, and typing every screen against that would bake
 * today's answer to the casing question into every call site), but a renamed route is a typecheck
 * failure rather than a 404 somebody finds on their phone.
 */

/**
 * Every route this file calls, as a suffix of the StingStream API root.
 *
 * The `satisfies` is the point: TypeScript has to prove each of these, prefixed with
 * `/stingstream/api/v1`, is a real path in the node's own OpenAPI document. Rename one in
 * `WatchController`, regenerate, and this file stops compiling.
 *
 * Regenerating is also what found `WatchController`'s route: it had inherited the base's
 * `[controller]` token and was publishing `/Watch` into the document while everything else here
 * said `/watch`. Routing is case-insensitive so nothing was broken, but a generated client pins
 * whatever the document says â€” so the controller now spells its route out like every sibling.
 */
const ROUTES = {
  list: "/watch",
  start: "/watch",
  one: "/watch/{sessionId}",
  join: "/watch/{sessionId}/join",
  leave: "/watch/{sessionId}/leave",
} as const satisfies Record<string, ApiSuffix>;

/**
 * A suffix that names a real path in the generated OpenAPI document.
 *
 * Distributive on purpose â€” see the identical type in `requestsApi.ts`: a naked type parameter
 * applies the conditional per member of `keyof paths`, where writing it inline over the whole
 * union infers `string` and accepts every typo silently.
 */
type Strip<T> = T extends `/stingstream/api/v1${infer Suffix}` ? Suffix : never;
type ApiSuffix = Strip<keyof paths>;

/** `/watch/{sessionId}`-shaped routes, with the id filled in. */
const withSession = (route: string, sessionId: string): string =>
  route.replace("{sessionId}", encodeURIComponent(sessionId));

/** What a session is doing. Mirrors `WatchState` in Core and `WatchState` in the mesh. */
export type WatchState = "idle" | "paused" | "playing";

/** One node taking part in a session. */
export interface WatchParticipant {
  node: string;
  nodeName: string;
  /** How many of that node's own users are in its local SyncPlay group. Display only. */
  viewers: number;
  /** Round-trip time the leader measured to it, milliseconds. */
  rttMs?: number | null;
  /**
   * How far that node's own group was from the leader's when it last reported, signed
   * milliseconds. Positive means it is ahead. The milestone's bar is that this stays under 1000.
   */
  driftMs?: number | null;
  buffering: boolean;
  lastSeenMs: number;
}

/** A watch-together session, as the group holds it. */
export interface WatchSession {
  id: string;
  /** The title everybody is watching, in the group index's own terms. */
  itemKey: string;
  title: string;
  /** The node that owns every position in this session. */
  leader: string;
  leaderName: string;
  participants: WatchParticipant[];
  state: WatchState;
  positionMs: number;
  /** The instant `positionMs` was true, on the *leader's* clock. */
  atMs: number;
  seq: number;
  closed: boolean;
  updatedAtMs: number;
}

/** A session plus where it is right now, from `GET /watch/{id}`. */
export interface WatchSessionView {
  session: WatchSession | null;
  /** Where every member should be at `nowMs`, milliseconds. */
  positionMs: number;
  nowMs: number;
}

const toParticipant = (raw: unknown): WatchParticipant => ({
  node: field<string>(raw, ...both("node")) ?? "",
  nodeName: field<string>(raw, ...both("nodeName")) ?? "",
  viewers: field<number>(raw, ...both("viewers")) ?? 0,
  rttMs: field<number>(raw, ...both("rttMs"), "RttMs"),
  driftMs: field<number>(raw, ...both("driftMs")),
  buffering: field<boolean>(raw, ...both("buffering")) ?? false,
  lastSeenMs: field<number>(raw, ...both("lastSeenMs")) ?? 0,
});

export const toWatchSession = (raw: unknown): WatchSession => ({
  id: field<string>(raw, ...both("id")) ?? "",
  itemKey: field<string>(raw, ...both("itemKey")) ?? "",
  title: field<string>(raw, ...both("title")) ?? "",
  leader: field<string>(raw, ...both("leader")) ?? "",
  leaderName: field<string>(raw, ...both("leaderName")) ?? "",
  participants: (field<unknown[]>(raw, ...both("participants")) ?? []).map(
    toParticipant,
  ),
  state: (field<string>(raw, ...both("state")) as WatchState) ?? "idle",
  positionMs: field<number>(raw, ...both("positionMs")) ?? 0,
  atMs: field<number>(raw, ...both("atMs")) ?? 0,
  seq: field<number>(raw, ...both("seq")) ?? 0,
  closed: field<boolean>(raw, ...both("closed")) ?? false,
  updatedAtMs: field<number>(raw, ...both("updatedAtMs")) ?? 0,
});

export const toWatchSessionView = (raw: unknown): WatchSessionView => {
  const session = field<unknown>(raw, ...both("session"));
  return {
    session: session ? toWatchSession(session) : null,
    positionMs: field<number>(raw, ...both("positionMs")) ?? 0,
    nowMs: field<number>(raw, ...both("nowMs")) ?? 0,
  };
};

/**
 * Whether this device's own node is already in a session.
 *
 * The invite banner turns on exactly when this is false and a session exists â€” so it has to be
 * decided from the session itself rather than from local state, or a second device on the same node
 * would be offered an invite to a room its node is already in.
 */
export const isNodeInSession = (
  session: WatchSession,
  nodeId: string | null | undefined,
): boolean => {
  if (!nodeId) return false;
  const mine = nodeId.toLowerCase();
  if (session.leader.toLowerCase() === mine) return true;
  return session.participants.some((p) => p.node.toLowerCase() === mine);
};

/**
 * The one session worth offering an invite to, out of everything the group has open.
 *
 * Newest first, and only the ones this node is not already in. There is deliberately no queue: two
 * open watch parties in one small group is rare enough that a list is more interface than it is
 * worth, and the newest is the one somebody has just started â€” which is the one an invite is about.
 */
export const invitableSession = (
  sessions: readonly WatchSession[],
  nodeId: string | null | undefined,
): WatchSession | null =>
  [...sessions]
    .filter((s) => !s.closed && !isNodeInSession(s, nodeId))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0] ?? null;

/**
 * How far the worst-placed node is from the leader, in milliseconds, or null when nobody has
 * reported yet.
 *
 * What the "in sync" pill shows. Absolute, because a room that is 400 ms *behind* is exactly as out
 * of step as one 400 ms ahead.
 */
export const worstDriftMs = (session: WatchSession): number | null => {
  const drifts = session.participants
    .map((p) => p.driftMs)
    .filter((d): d is number => typeof d === "number");
  return drifts.length === 0
    ? null
    : Math.max(...drifts.map((d) => Math.abs(d)));
};

/** The bar M7 set itself, and what the pill turns amber at. */
export const DRIFT_BUDGET_MS = 1000;

/** Every open session this node can see. */
export async function fetchWatchSessions(
  apiBaseUrl: string,
  accessToken?: string | null,
  group?: string | null,
): Promise<WatchSession[]> {
  const qs = group ? `?group=${encodeURIComponent(group)}` : "";
  const res = await fetch(`${apiBaseUrl}${ROUTES.list}${qs}`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "listing watch sessions");
  const body = await res.json();
  return (Array.isArray(body) ? body : []).map(toWatchSession);
}

/** One session, and where it is right now. */
export async function fetchWatchSession(
  apiBaseUrl: string,
  sessionId: string,
  accessToken?: string | null,
): Promise<WatchSessionView | null> {
  const res = await fetch(
    `${apiBaseUrl}${withSession(ROUTES.one, sessionId)}`,
    { headers: authHeaders(accessToken) },
  );
  // A session that has ended is a 404, and that is not an error worth showing anybody: the room
  // closed, which is a thing rooms do.
  if (res.status === 404) return null;
  if (!res.ok) throw await readError(res, "reading a watch session");
  return toWatchSessionView(await res.json());
}

/** Start a session for an item, with this node leading it. */
export async function startWatchSession(
  apiBaseUrl: string,
  itemId: string,
  accessToken?: string | null,
  group?: string | null,
): Promise<WatchSession> {
  const res = await fetch(`${apiBaseUrl}${ROUTES.start}`, {
    method: "POST",
    headers: {
      ...authHeaders(accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ItemId: itemId, Group: group ?? null }),
  });
  if (!res.ok) throw await readError(res, "starting a watch session");
  return toWatchSession(await res.json());
}

/** Join a session another node leads. */
export async function joinWatchSession(
  apiBaseUrl: string,
  sessionId: string,
  accessToken?: string | null,
  group?: string | null,
): Promise<WatchSession> {
  const qs = group ? `?group=${encodeURIComponent(group)}` : "";
  const res = await fetch(
    `${apiBaseUrl}${withSession(ROUTES.join, sessionId)}${qs}`,
    { method: "POST", headers: authHeaders(accessToken) },
  );
  if (!res.ok) throw await readError(res, "joining a watch session");
  return toWatchSession(await res.json());
}

/** Leave a session; if this node leads it, this ends it for everybody. */
export async function leaveWatchSession(
  apiBaseUrl: string,
  sessionId: string,
  accessToken?: string | null,
): Promise<void> {
  const res = await fetch(
    `${apiBaseUrl}${withSession(ROUTES.leave, sessionId)}`,
    { method: "POST", headers: authHeaders(accessToken) },
  );
  if (!res.ok) throw await readError(res, "leaving a watch session");
}
