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

export const toInviteCode = (raw: unknown): string =>
  field<string>(raw, ...both("code")) ?? "";

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
