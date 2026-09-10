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
 * rather than serialising them, so an unset field has no key at all. Typing it as `string | null`
 * would let code assume the key is present.
 */
export interface MeshNodeGroup {
  group: string;
  name: string;
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
   * Absent means "race nothing", which is the ordinary state for a node whose owner has set no
   * address: it is reachable on its own network and through the app's mesh, and not from a browser
   * anywhere else.
   */
  sideDoor?: SideDoorRecord | null;
}

export interface MeshInvite {
  code: string;
  /**
   * The same invite as a link, or `null` when this node has no host to build one from.
   *
   * Null is an ordinary outcome and not a failure: a member with no address of their own has
   * nowhere to point a link, and the screen shows the bare code instead.
   */
  url: string | null;
}

/**
 * Where people reach this node — `GET`/`PUT /mesh/settings/sharing`.
 *
 * Both values belong to the node rather than to any group, which is the point of them. Only the
 * person minting a link can say which address it should carry, and a group has as many answers to
 * that as it has members.
 */
export interface MeshSharingSettings {
  /** A domain pointed at this node, origin only. `null` when unset. */
  publicAddress: string | null;
}

export interface MeshJoinResponse {
  group: string;
  name: string;
  via: "inviter" | "none";
  contacted: string[];
}

/** A library on this server, named so a person can recognise it. */
export interface MeshLibrary {
  id: string;
  name: string;
  collectionType?: string | null;
}

/**
 * What this server shares into one link, and what it could share.
 *
 * Both halves in one answer because the screen draws a single list with checkmarks, and two
 * requests to draw one list is two chances for them to disagree.
 */
export interface SharedLibraries {
  /** Collection-folder ids. Empty means this link gets nothing, which is a new link's default. */
  shared: string[];
  available: MeshLibrary[];
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

export const toInvite = (raw: unknown): MeshInvite => ({
  code: toInviteCode(raw),
  url: field<string>(raw, ...both("url")) ?? null,
});

/**
 * An absent field means "not configured", which is the same thing an empty string means once it
 * has been through the node's own normalisation — so both arrive here as `null` and no caller has
 * to tell them apart.
 */
export const toSharingSettings = (raw: unknown): MeshSharingSettings => {
  const read = (name: string) =>
    field<string>(raw, ...both(name))?.trim() || null;
  return {
    publicAddress: read("publicAddress"),
  };
};

/**
 * Whether this node is running a Cloudflare Tunnel.
 *
 * `named` is a tunnel on a domain its owner controls, which is the only kind there is. There was
 * briefly a `quick` one — Cloudflare's account-free tunnel, on a `*.trycloudflare.com` name
 * reassigned on every restart. Dan cut it: *"they either configure a domain manually OR via
 * cloudflare"*. An address that changes every restart cannot be sent to anybody and cannot carry a
 * passkey, so it was never an answer to the question this page asks.
 */
export type MeshTunnelKind = "none" | "named";

/**
 * Four states rather than a boolean, because "you have not set this up", "it is coming up" and "it
 * is broken" send somebody to three different places. `SideDoorStatus` on the node splits `off`
 * from `no_certificate` for the same reason.
 */
export type MeshTunnelState = "off" | "starting" | "connected" | "error";

/** What the node is running, and where it got to. */
export interface MeshTunnelStatus {
  kind: MeshTunnelKind;
  state: MeshTunnelState;
  /** The name the tunnel answers on. */
  hostname: string | null;
  /** Why it is starting or broken, in words, straight from the node. */
  detail: string | null;
  /**
   * Whether `cloudflared` is actually on this machine.
   *
   * Reported rather than assumed so the page can say "install this" instead of offering a button
   * that fails: a node built without the fetch script having run has no tunnel to offer, and that
   * is a sentence, not an error.
   */
  binaryPresent: boolean;
}

/** Whether the gateway is serving TLS itself, mirroring `SideDoorStatus::state` on the node. */
export type MeshHttpsState = "off" | "no_certificate" | "ready";

/** The certificate in `$STINGSTREAM_DATA/tls/`, when there is one. */
export interface MeshCertificate {
  names: string[];
  /** RFC 3339, or `null` if the node could read the chain but not a validity window. */
  expires: string | null;
}

/**
 * Everything the Domains page reports — `GET /mesh/domains`.
 *
 * One document rather than a read per fact, and an *authenticated* one. The same information is in
 * `/healthz`, but the node redacts that for anybody calling from off-machine (it otherwise carries
 * child ports and the data directory), so a browser reaching this server through the very tunnel
 * this page sets up would see a hollowed-out version of the page that set it up.
 */
export interface MeshDomainsStatus {
  /** The address invite links are built from, as the node stores it. */
  publicAddress: string | null;
  https: MeshHttpsState;
  certificate: MeshCertificate | null;
  /**
   * This node's address as the world sees it, when the port mapper could learn one.
   *
   * Shown for the benefit of somebody forwarding a port by hand — it is the number they type into
   * their router — and `null` behind carrier-grade NAT, which is itself the answer to why the
   * forwarding never worked.
   */
  publicIp: string | null;
  /** Plain-HTTP URLs this node answers on inside the house. */
  lanUrls: string[];
  tunnel: MeshTunnelStatus;
}

const TUNNEL_KINDS: MeshTunnelKind[] = ["none", "named"];
const TUNNEL_STATES: MeshTunnelState[] = [
  "off",
  "starting",
  "connected",
  "error",
];
const HTTPS_STATES: MeshHttpsState[] = ["off", "no_certificate", "ready"];

/**
 * A value this build has never heard of reads as the quietest option, never as a thrown decode.
 *
 * A node one version ahead may name a state that did not exist when this app was built, and the
 * honest render for that is the same as for a node with nothing set up. Refusing to decode would
 * take the address field down with it, and that is the part that always works.
 */
const oneOf = <T extends string>(
  allowed: T[],
  raw: unknown,
  name: string,
  fallback: T,
): T => {
  const value = field<string>(raw, ...both(name));
  return allowed.includes(value as T) ? (value as T) : fallback;
};

export const toTunnelStatus = (raw: unknown): MeshTunnelStatus => ({
  kind: oneOf(TUNNEL_KINDS, raw, "kind", "none"),
  state: oneOf(TUNNEL_STATES, raw, "state", "off"),
  hostname: field<string>(raw, ...both("hostname"))?.trim() || null,
  detail: field<string>(raw, ...both("detail"))?.trim() || null,
  binaryPresent: field<boolean>(raw, ...both("binaryPresent")) ?? false,
});

export const toDomainsStatus = (raw: unknown): MeshDomainsStatus => {
  const certificate = field<unknown>(raw, ...both("certificate"));
  return {
    publicAddress: field<string>(raw, ...both("publicAddress"))?.trim() || null,
    https: oneOf(HTTPS_STATES, raw, "https", "off"),
    certificate: certificate
      ? {
          names: field<string[]>(certificate, ...both("names")) ?? [],
          expires:
            field<string>(certificate, ...both("expires"))?.trim() || null,
        }
      : null,
    publicIp: field<string>(raw, ...both("publicIp"))?.trim() || null,
    lanUrls: field<string[]>(raw, ...both("lanUrls")) ?? [],
    tunnel: toTunnelStatus(field<unknown>(raw, ...both("tunnel")) ?? {}),
  };
};

/** What the page sends to start a tunnel. The token is write-only and never comes back. */
export interface MeshTunnelRequest {
  kind: "named";
  hostname: string;
  apiToken: string;
}

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
      ? members.map((m) => ({
          ...m,
          ...links.get(m.node.toLowerCase()),
          // **This server is online by definition**: you are talking to it. The mesh tracks
          // liveness by peer connection and holds none to itself, so the roster reported this node
          // as offline on the very screen it was serving. Dan: *"Why does this server say offline
          // when im on the fucking server"*.
          online: m.isSelf ? true : m.online,
        }))
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

// --- the Sharing screen's cards, decided here so they can be tested -----------------------------
//
// `GroupCard` and `MemberCard` are presentation only: every number and label they show is computed
// here, pure, so the display logic can be tested without mounting a component.

/** How many members a group has, and how many are online right now, from the peer list. */
export interface GroupCounts {
  members: number;
  online: number;
}

/** `useNodeMeshPeers(null)`'s rows, narrowed to one group and counted. */
export const groupCounts = (
  peers: readonly MeshNodePeer[] | undefined,
  group: string,
): GroupCounts => {
  const rows = (peers ?? []).filter(
    (p) => p.group.toLowerCase() === group.toLowerCase(),
  );
  return { members: rows.length, online: rows.filter((p) => p.online).length };
};

export type GroupSyncState = "synced" | "syncing";

/**
 * Whether the Sharing screen's card should say a group is fully synced to this device or still
 * catching up.
 *
 * "Syncing" is not an error: a group the home node just created or joined has not reached the
 * embedded light node yet (`MeshProvider`'s sync runs on a timer, not instantly), and the card says
 * so rather than implying the group is already live everywhere it should be.
 */
export const groupSyncState = (
  meshAvailable: boolean,
  joinedOnThisDevice: boolean,
): GroupSyncState =>
  meshAvailable && !joinedOnThisDevice ? "syncing" : "synced";

/** The three link states a member row can be in, collapsed from the mesh's own path strings. */
export type LinkPath = "direct" | "relayed" | "connecting";

/** `direct`/`mixed` read as one path — both mean bytes travel peer to peer without a relay. */
export const pathCategory = (path: string | null | undefined): LinkPath => {
  if (path === "direct" || path === "mixed") return "direct";
  if (path === "relay") return "relayed";
  return "connecting";
};

/** A round trip in a form worth putting on a card, or null when nothing has been measured yet. */
export const rttLabel = (rttMs: number | null | undefined): string | null =>
  rttMs != null ? `${rttMs} ms` : null;

/** A member's name, or a readable piece of its node id until it has said what it is called. */
export const memberDisplayName = (
  member: Pick<MeshMember, "node" | "nodeName">,
): string => member.nodeName || shortenNodeId(member.node);

/** 64 hex characters do not fit a card, and the first 12 identify a node in a log. */
export const shortenNodeId = (nodeId: string): string =>
  nodeId.length > 16 ? `${nodeId.slice(0, 12)}…` : nodeId;

/**
 * One or two letters for an avatar: initials from a name with words in it, or the first two
 * characters of a bare node id when nothing has been named yet.
 */
export const initials = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
};

/**
 * The most recent moment any peer of a group was heard from — a stand-in for "last synced" on the
 * Sharing screen's group card, since the mesh has no per-group sync timestamp of its own.
 */
export const latestPeerActivity = (
  peers: readonly MeshNodePeer[],
): Age | null => {
  let best: Age | null = null;
  for (const peer of peers) {
    const age = ageOf(peer.lastSeen);
    if (age && (!best || age.at > best.at)) best = age;
  }
  return best;
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
      `${what}: this needs an administrator account on your server.`,
    );
  }
  // Core answers 503 when it cannot reach the mesh child, rather than an empty result — because
  // "no groups" and "I could not ask" look identical in a body and mean opposite things. On the
  // node side that distinction stops the federated materializer deleting every pointer during a
  // mesh restart; here it stops the Group screen telling the user they belong to nothing.
  if (res.status === 503) {
    // Not shown to the user as-is — the screen catches `MeshUnavailableError` and shows its own
    // translated copy (`sharing.mesh_unavailable_detail`) instead, so this message never has to
    // clear the "no node, no mesh" wording rule; it exists for logs and error reporting.
    return new MeshUnavailableError(
      "Sharing isn't answering on this server. Groups and peers are unavailable until it comes back; playback still works through the server.",
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

/** Core answers PascalCase; `both()` reads either spelling, as everything else here does. */
export function toSharedLibraries(raw: unknown): SharedLibraries {
  const shared = field<unknown[]>(raw, ...both("shared")) ?? [];
  const available = field<unknown[]>(raw, ...both("available")) ?? [];
  return {
    shared: shared.filter((id): id is string => typeof id === "string"),
    available: available.map((entry) => ({
      id: field<string>(entry, ...both("id")) ?? "",
      name: field<string>(entry, ...both("name")) ?? "",
      collectionType: field<string>(entry, ...both("collectionType")) ?? null,
    })),
  };
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
