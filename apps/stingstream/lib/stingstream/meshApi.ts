import type { SideDoorRecord } from "./sidedoor";

/**
 * The plain-fetch half of `lib/stingstream/mesh.ts` — the **home node's** mesh,
 * `/stingstream/api/v1/mesh/*`, `StingStream.Core`'s `MeshController` sitting in front of the
 * mesh's own loopback API with Jellyfin's authentication on it. See `mesh.ts` for the fuller
 * picture (two meshes, elevation, why this is hand-written).
 *
 * Split out from `mesh.ts` so this can be imported with **no React dependency at all**: `mesh.ts`
 * reaches `apiAtom` from `providers/JellyfinProvider` at module scope for its React Query hooks,
 * and that provider's own import graph is not something `bun:test` can load (a native
 * `codegenNativeComponent` a few layers down). `castStreamUrl.ts` needs `fetchMeshPeers` and
 * `fetchMeshStatus` from a non-React context — resolving a cast URL happens from inside a
 * `showActionSheetWithOptions` callback, not a component body — and unit-testing it means this
 * module must not drag react-native in just to make two fetch calls. `mesh.ts` re-exports
 * everything here, so nothing that already imports from `mesh.ts` needs to change.
 */

/**
 * `GET /mesh/groups`, and the body of `POST /mesh/groups`.
 *
 * Every nullable field here is **optional**, not `T | null`: Core omits nulls from its JSON
 * rather than serialising them, so a group with no coordinator has no `coordinator` key at all.
 * Typing it as `string | null` would let code assume the key is present.
 */
export interface MeshNodeGroup {
  group: string;
  name: string;
  /**
   * Absent for the zero-server default. The mesh normalises what it stores — `https://host`
   * comes back as `https://host/` — so never compare this to what a user typed.
   */
  coordinator?: string | null;
  createdAt: string;
}

/** `GET /mesh/peers`. Nulls are omitted, so every optional field may simply be missing. */
export interface MeshNodePeer {
  group: string;
  node: string;
  nodeName: string;
  online: boolean;
  firstSeen: string;
  lastSeen?: string | null;
  /** `direct`, `relay`, `mixed`, or absent when nothing has connected yet. */
  path?: string | null;
  rttMs?: number | null;
  maxDirectStreams?: number | null;
  maxTranscodes?: number | null;
  activeDirectStreams?: number | null;
  activeTranscodes?: number | null;
  freeSpace?: number | null;
  /**
   * Where a browser can reach *this peer* over HTTPS, as the peer last gossiped it. What a cast
   * sender races when it hands a receiver a URL for a film held by another node.
   */
  sideDoor?: SideDoorRecord | null;
}

/** `GET /mesh/status`. */
export interface MeshNodeStatus {
  node: string;
  nodeName: string;
  version: string;
  groups: number;
  availableStreams: number;
  relayUrls: string[];
  directAddrs: string[];
  /**
   * Where a browser can reach this node over HTTPS (`docs/SIDEDOOR.md`).
   *
   * Optional twice over: a node with no coordinator publishes none, and Core only forwards the
   * field on a build that knows about it. Absent means "race nothing"; the web bundle falls back
   * to the coordinator's public discovery record.
   */
  sideDoor?: SideDoorRecord | null;
}

export interface MeshInvite {
  code: string;
}

export interface MeshJoinResponse {
  group: string;
  name: string;
  coordinator?: string | null;
  via: "inviter" | "rendezvous" | "none";
  contacted: string[];
}

/**
 * One member of a group, from `GET /mesh/groups/{group}/members`.
 *
 * Deliberately not the same shape as {@link MeshNodePeer}, even though both describe the same
 * machines: `/mesh/peers` is the *measurement* — path, round trip, free space — and this is the
 * *membership*. Only this one knows which row is the node answering the question and which rows
 * belong to members that have been removed, and only this one is elevated.
 */
export interface MeshMember {
  /** The member's node id, hex. */
  node: string;
  /** What the member calls itself. Empty until it has said, which is why the UI falls back. */
  nodeName: string;
  online: boolean;
  lastSeen?: string | null;
  /**
   * The node answering the request — the **home node**, never the light node inside this app. A
   * node cannot remove itself from a group; that is what leaving is for.
   */
  isSelf: boolean;
  /**
   * Removed from the group. The node stays on the list rather than disappearing from it, so an
   * administrator can see that a removal happened instead of wondering where somebody went.
   */
  revoked: boolean;
}

/** `GET /mesh/groups/{group}/members`. Elevated. */
export interface MeshGroupMembers {
  members: MeshMember[];
  /** How many times this group's secret has been rotated. `0` is a group that never has. */
  epoch: number;
  /**
   * Milliseconds since the Unix epoch at the last rotation, `0` when there has been none.
   *
   * A number rather than the ISO string every other timestamp on this API uses, and taken from the
   * *rotating* node's clock rather than this one's — so it can sit a little in the future, and the
   * age {@link ageOf} derives from it is clamped for exactly that reason.
   */
  rotatedAt: number;
  rotatedBy: string;
}

/**
 * The answer to a removal or a rotation.
 *
 * `reached` is the honest part: a rotation hands the new secret to each member in turn, and the
 * ones that were asleep are simply not in the list. They take it from the grace window on their
 * next dial, so a short list is not a failure and the UI says so.
 */
export interface MeshRotation {
  group: string;
  /** The epoch the group is now at. */
  epoch: number;
  /** The node removed. Absent on a plain rotation, where nobody was. */
  removed?: string | null;
  reached: string[];
}

/**
 * Read a field that may arrive in either casing.
 *
 * `StingStreamControllerBase` says the API is "plain camelCase JSON", and it is not: Core is
 * hosted inside Jellyfin, whose global `JsonSerializerOptions` are PascalCase, and the controller
 * base overrides the `[Produces]` media types without touching the naming policy. So
 * `GET /mesh/groups` really answers `[{"Group": "…", "Name": "…"}]`. Discovered by logging into a
 * real node from the emulator and watching auto-membership quietly do nothing.
 *
 * Reading both is the right fix at this layer rather than picking a side: the casing is not
 * something the Group screen should be brittle about, and if anyone later adds a camelCase policy
 * — which would match the documented intent — nothing here has to change. Nulls are omitted from
 * the wire either way, so every optional field may simply be absent.
 */
export const field = <T>(raw: unknown, ...names: string[]): T | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) {
      return record[name] as T;
    }
  }
  return undefined;
};

/** Both spellings of one name: `nodeName` and `NodeName`. */
export const both = (camel: string): string[] => [
  camel,
  camel.charAt(0).toUpperCase() + camel.slice(1),
];

export const toGroup = (raw: unknown): MeshNodeGroup => ({
  group: field<string>(raw, ...both("group")) ?? "",
  name: field<string>(raw, ...both("name")) ?? "",
  coordinator: field<string>(raw, ...both("coordinator")),
  createdAt: field<string>(raw, ...both("createdAt")) ?? "",
});

export const toPeer = (raw: unknown): MeshNodePeer => ({
  group: field<string>(raw, ...both("group")) ?? "",
  node: field<string>(raw, ...both("node")) ?? "",
  nodeName: field<string>(raw, ...both("nodeName")) ?? "",
  online: field<boolean>(raw, ...both("online")) ?? false,
  firstSeen: field<string>(raw, ...both("firstSeen")) ?? "",
  lastSeen: field<string>(raw, ...both("lastSeen")),
  path: field<string>(raw, ...both("path")),
  rttMs: field<number>(raw, ...both("rttMs"), "RttMs"),
  maxDirectStreams: field<number>(raw, ...both("maxDirectStreams")),
  maxTranscodes: field<number>(raw, ...both("maxTranscodes")),
  activeDirectStreams: field<number>(raw, ...both("activeDirectStreams")),
  activeTranscodes: field<number>(raw, ...both("activeTranscodes")),
  freeSpace: field<number>(raw, ...both("freeSpace")),
  // `SideDoor` rides the mesh's own heartbeat as a raw JsonElement passthrough (see
  // `server/jellyfin/src/StingStream.Core/Mesh/MeshModels.cs`), so unlike every other field on
  // this DTO it is already snake_case underneath — `field()`'s both-casing lookup still finds it
  // under the outer PascalCase key, and its own inner keys (`direct_https`, `lan_ips`, ...) need
  // no translation at all. This was previously dropped entirely: the interface declared it but
  // nothing here read it, so a cast sender racing a peer's side door always fell through to the
  // discovery-record fallback. See docs/SIDEDOOR.md §5, "Where the client gets the record".
  sideDoor: field<SideDoorRecord>(raw, ...both("sideDoor")) ?? null,
});

export const toStatus = (raw: unknown): MeshNodeStatus => ({
  node: field<string>(raw, ...both("node")) ?? "",
  nodeName: field<string>(raw, ...both("nodeName")) ?? "",
  version: field<string>(raw, ...both("version")) ?? "",
  groups: field<number>(raw, ...both("groups")) ?? 0,
  availableStreams: field<number>(raw, ...both("availableStreams")) ?? 0,
  relayUrls: field<string[]>(raw, ...both("relayUrls")) ?? [],
  directAddrs: field<string[]>(raw, ...both("directAddrs")) ?? [],
  sideDoor: field<SideDoorRecord>(raw, ...both("sideDoor")) ?? null,
});

export const toJoin = (raw: unknown): MeshJoinResponse => ({
  group: field<string>(raw, ...both("group")) ?? "",
  name: field<string>(raw, ...both("name")) ?? "",
  coordinator: field<string>(raw, ...both("coordinator")),
  via: (field<string>(raw, ...both("via")) ??
    "none") as MeshJoinResponse["via"],
  contacted: field<string[]>(raw, ...both("contacted")) ?? [],
});

export const toMember = (raw: unknown): MeshMember => ({
  node: field<string>(raw, ...both("node")) ?? "",
  nodeName: field<string>(raw, ...both("nodeName")) ?? "",
  online: field<boolean>(raw, ...both("online")) ?? false,
  lastSeen: field<string>(raw, ...both("lastSeen")),
  isSelf: field<boolean>(raw, ...both("isSelf")) ?? false,
  revoked: field<boolean>(raw, ...both("revoked")) ?? false,
});

export const toMembers = (raw: unknown): MeshGroupMembers => ({
  members: (field<unknown[]>(raw, ...both("members")) ?? []).map(toMember),
  epoch: field<number>(raw, ...both("epoch")) ?? 0,
  rotatedAt: field<number>(raw, ...both("rotatedAt")) ?? 0,
  rotatedBy: field<string>(raw, ...both("rotatedBy")) ?? "",
});

export const toRotation = (raw: unknown): MeshRotation => ({
  group: field<string>(raw, ...both("group")) ?? "",
  epoch: field<number>(raw, ...both("epoch")) ?? 0,
  removed: field<string>(raw, ...both("removed")),
  reached: field<string[]>(raw, ...both("reached")) ?? [],
});

export const toInviteCode = (raw: unknown): string =>
  field<string>(raw, ...both("code")) ?? "";

// --- the Group screen's member management, decided here so it can be tested ---------------------
//
// Everything below shapes what the member list shows and what it is allowed to offer. It lives in
// this module for the same reason the decoders above do: `bun:test` can load it, where anything
// that reaches `providers/JellyfinProvider` or `react-native` cannot. `watchApi.ts` splits its own
// view helpers from its hooks the same way.

/**
 * One row of the member list: the membership, plus whatever the peer list knows about the link.
 *
 * The two halves come from different endpoints — `/mesh/groups/{group}/members` is elevated and
 * knows about removals, `/mesh/peers` is not and knows about paths — so a row is a join of the two
 * rather than either one on its own.
 */
export interface MemberRow extends MeshMember {
  /** `direct`, `relay`, `mixed`, or absent when nothing has connected yet. */
  path?: string | null;
  rttMs?: number | null;
  freeSpace?: number | null;
}

/**
 * Whether this account, on this device, may manage a group's membership.
 *
 * Two gates, and both matter. Removing a member and rotating a secret are `RequiresElevation` on
 * the node, so offering them to anybody else is offering a button that answers 403 — and the
 * member list itself is elevated too, which is why a non-administrator never even asks for it.
 * Television is the second gate: management screens stay phone/web-only across this app
 * (`docs/ARCHITECTURE.md`), and an irreversible, group-wide action confirmed on a remote control
 * is the last place that rule should be relaxed.
 */
export const canManageMembers = (isAdmin: boolean, isTV: boolean): boolean =>
  isAdmin && !isTV;

/**
 * Whether a particular row may be removed.
 *
 * Never the node answering the request — a node leaves a group, it does not remove itself — and
 * never one that has already been removed, because a second removal would rotate the secret again
 * and invalidate everybody's invite codes for no gain.
 */
export const canRemoveMember = (
  member: Pick<MeshMember, "isSelf" | "revoked"> | null | undefined,
  manageable: boolean,
): boolean => !!member && manageable && !member.isSelf && !member.revoked;

/**
 * The member list, ordered the way an administrator wants to read it.
 *
 * `members` is authoritative when it is there: it is the only source that knows about removed
 * members, and the peer list is joined onto it purely for the link detail. When it is *not* there
 * — a non-administrator, a television, or a node too old to serve the endpoint — the peer list
 * alone still produces a perfectly good roster, minus the two things only the elevated endpoint
 * knows. That fallback is what keeps the screen unchanged for everybody who cannot manage.
 */
export const memberRoster = (
  members: readonly MeshMember[] | undefined,
  peers: readonly MeshNodePeer[] | undefined,
): MemberRow[] => {
  const links = new Map(
    (peers ?? []).map((p) => [
      p.node.toLowerCase(),
      { path: p.path, rttMs: p.rttMs, freeSpace: p.freeSpace },
    ]),
  );

  const rows: MemberRow[] =
    members && members.length > 0
      ? members.map((m) => ({ ...m, ...links.get(m.node.toLowerCase()) }))
      : (peers ?? []).map((p) => ({
          node: p.node,
          nodeName: p.nodeName,
          online: p.online,
          lastSeen: p.lastSeen,
          isSelf: false,
          revoked: false,
          path: p.path,
          rttMs: p.rttMs,
          freeSpace: p.freeSpace,
        }));

  // Removed members sink to the bottom: they are kept on the list so the removal is visible, not
  // because they are still part of the group.
  return rows.sort((a, b) => {
    if (a.revoked !== b.revoked) return a.revoked ? 1 : -1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.nodeName || a.node).localeCompare(b.nodeName || b.node);
  });
};

/** How long ago something happened, in a form the Group screen can put in a sentence. */
export interface Age {
  /**
   * A compact `4m` / `3h` / `2d`, or null once the moment is more than a week old — at which point
   * an absolute date says more than a growing number of days does.
   */
  token: string | null;
  /** The moment itself, for that absolute fallback. */
  at: number;
}

/**
 * Read a moment that may be an ISO string (`lastSeen`) or milliseconds since the epoch
 * (`rotatedAt`), and say how old it is. Null when there is no moment at all.
 *
 * The age is clamped at zero because `rotatedAt` comes from the clock of whichever node performed
 * the rotation, not this one's: a couple of seconds of skew between two machines is ordinary, and
 * "rotated in 3 seconds' time" is not a thing to put on screen.
 */
export const ageOf = (
  value: string | number | null | undefined,
  now: number = Date.now(),
): Age | null => {
  if (value === null || value === undefined || value === "" || value === 0) {
    return null;
  }
  const at = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(at) || at <= 0) return null;

  const ms = Math.max(0, now - at);
  const hours = ms / 3_600_000;
  if (hours < 1) {
    return { token: `${Math.max(1, Math.round(ms / 60_000))}m`, at };
  }
  if (hours < 24) return { token: `${Math.round(hours)}h`, at };
  if (hours < 24 * 7) return { token: `${Math.round(hours / 24)}d`, at };
  return { token: null, at };
};

/**
 * Do something irreversible only once it is both allowed and confirmed.
 *
 * The order is the point. Asking first and checking after would put a frightening question in front
 * of somebody whose answer was going to be a 403 anyway, and checking `allowed` here rather than
 * only at the call site means a button that should never have rendered still cannot fire. Resolves
 * to null when either gate refused, which is not an error and should not be reported as one.
 */
export async function confirmedAction<T>(input: {
  allowed: boolean;
  confirm: () => Promise<boolean>;
  act: () => Promise<T>;
}): Promise<T | null> {
  if (!input.allowed) return null;
  if (!(await input.confirm())) return null;
  return await input.act();
}

/**
 * Read whatever the node said went wrong.
 *
 * Core answers `{"error": "…"}` carrying the mesh's own context chain, and Jellyfin answers a
 * ProblemDetails object; a proxy in between may answer neither. All three end up as one sentence
 * the Group screen can show.
 */
export class MeshUnavailableError extends Error {
  readonly unavailable = true;
}

export const readError = async (
  res: Response,
  what: string,
): Promise<Error> => {
  if (res.status === 401 || res.status === 403) {
    return new Error(
      `${what}: this needs a Jellyfin administrator account on the home node.`,
    );
  }
  // Core answers 503 when it cannot reach the mesh child, rather than an empty result — because
  // "no groups" and "I could not ask" look identical in a body and mean opposite things. On the
  // node side that distinction stops the federated materializer deleting every pointer during a
  // mesh restart; here it stops the Group screen telling the user they belong to nothing.
  if (res.status === 503) {
    return new MeshUnavailableError(
      "This node's mesh isn't answering. Groups and peers are unavailable until it comes back; playback still works through the home node.",
    );
  }
  let detail = `${res.status}`;
  try {
    const body = await res.json();
    if (typeof body?.error === "string") detail = body.error;
    else if (typeof body?.title === "string") detail = body.title;
  } catch {
    // A non-JSON body leaves the status as the message.
  }
  return new Error(`${what}: ${detail}`);
};

/** The Jellyfin token the whole app already uses; Core's auth *is* Jellyfin's auth. */
export const authHeaders = (
  token: string | null | undefined,
): Record<string, string> =>
  token ? { Authorization: `MediaBrowser Token="${token}"` } : {};

/** The home node's groups. */
export async function fetchMeshGroups(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<MeshNodeGroup[]> {
  const res = await fetch(`${apiBaseUrl}/mesh/groups`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /mesh/groups");
  return ((await res.json()) as unknown[]).map(toGroup);
}

/**
 * An invite for one group, so this device can join it as a light member.
 *
 * Minting an invite to oneself looks odd until you notice that an invite code is the only thing
 * that carries a group's *secret*, and the secret is what gates every peer connection. There is no
 * "export my membership" endpoint because an invite already is one.
 */
export async function fetchMeshInvite(
  apiBaseUrl: string,
  group: string,
  accessToken?: string | null,
): Promise<string> {
  const res = await fetch(
    `${apiBaseUrl}/mesh/groups/${encodeURIComponent(group)}/invite`,
    { method: "POST", headers: authHeaders(accessToken) },
  );
  if (!res.ok) throw await readError(res, `POST /mesh/groups/${group}/invite`);
  const code = toInviteCode(await res.json());
  if (!code) throw new Error("the node returned an invite with no code");
  return code;
}

/**
 * The home node's own mesh identity, including its `sideDoor` record when it has one. What a cast
 * sender checks first when the item being cast is held by the home node itself (rather than a
 * peer, which is `fetchMeshPeers` below).
 */
export async function fetchMeshStatus(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<MeshNodeStatus> {
  const res = await fetch(`${apiBaseUrl}/mesh/status`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /mesh/status");
  return toStatus(await res.json());
}

/**
 * Members of one group as the home node sees them — outside React, for `castStreamUrl.ts`, which
 * needs a peer's `sideDoor` record at the moment a cast starts rather than whatever a hook last
 * rendered.
 */
export async function fetchMeshPeers(
  apiBaseUrl: string,
  group: string,
  accessToken?: string | null,
): Promise<MeshNodePeer[]> {
  const res = await fetch(
    `${apiBaseUrl}/mesh/peers?group=${encodeURIComponent(group)}`,
    { headers: authHeaders(accessToken) },
  );
  if (!res.ok) throw await readError(res, "GET /mesh/peers");
  return ((await res.json()) as unknown[]).map(toPeer);
}
