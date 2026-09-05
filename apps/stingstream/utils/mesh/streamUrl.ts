/**
 * The `stingstream.local` → `127.0.0.1` rewrite.
 *
 * A federated library item is a `.strm` file holding
 * `https://stingstream.local/stream/<group>/<item_key>/<node>`. That host does not resolve
 * anywhere and is not meant to: it is a marker saying "this URL belongs to the mesh". Jellyfin
 * hands it to the app as a remote MediaSource path, and:
 *
 *  * **on a native build with the mesh running**, the app rewrites the host to its own embedded
 *    node's loopback port, and MPV pulls the bytes off the holder's disk over iroh — one hop,
 *    direct where hole-punching works.
 *  * **anywhere else** — web, a build without the module, a group this device has not joined —
 *    the URL is left exactly as it was, and the home node's gateway proxies `/stream/*` through
 *    its own mesh. Slower, but it always works, and it is why the rewrite may never guess.
 *
 * Everything here is a pure function over an explicit context so the rule can be tested without a
 * device; {@link rewriteStreamUrlForMesh} is the thin wrapper that reads the live state.
 *
 * See `docs/APP-MESH.md`.
 */

/** The host a federated `.strm` file carries. Matching is case-insensitive. */
export const MESH_STREAM_HOST = "stingstream.local";

/** The three path segments after `/stream`. */
export type MeshStreamTarget = {
  /** 64-character hex group id. */
  group: string;
  /** The item key, still percent-encoded exactly as it appeared. */
  itemKey: string;
  /** 64-character hex node id of the holder. */
  node: string;
  /** Query string and fragment, including their leading `?`/`#`, or `""`. */
  suffix: string;
};

/** What the rewrite needs to know about the embedded node. */
export type MeshRewriteContext = {
  /** The native module exists and the node is running. */
  available: boolean;
  /** The loopback port. `0` means there is nothing to rewrite to. */
  localPort: number;
  /** Group ids the embedded node has actually joined. */
  groups: readonly string[];
};

const NOT_RUNNING: MeshRewriteContext = {
  available: false,
  localPort: 0,
  groups: [],
};

/**
 * `https://stingstream.local[:port]/stream/<group>/<item_key>/<node>[?…][#…]`
 *
 * The scheme is `https` in every `.strm` the node writes, but `http` is accepted so a hand-written
 * pointer or an older node does not silently fall back to the slow path. An optional port is
 * tolerated for the same reason.
 */
const MESH_URL =
  /^https?:\/\/stingstream\.local(?::\d+)?\/stream\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)([?#].*)?$/i;

/**
 * Pull the group, item key and node out of a mesh stream URL.
 *
 * Returns `null` for anything that is not exactly this shape — a different host, a different path,
 * a missing or extra segment. Being strict is the point: a URL this does not recognise is left
 * alone and still plays through the home node.
 */
export const parseMeshStreamUrl = (
  url: string | null | undefined,
): MeshStreamTarget | null => {
  if (!url) return null;
  const match = MESH_URL.exec(url.trim());
  if (!match) return null;
  const [, group, itemKey, node, suffix] = match;
  return { group, itemKey, node, suffix: suffix ?? "" };
};

/**
 * Rewrite a mesh stream URL to the embedded node's loopback port, or return it unchanged.
 *
 * Unchanged when: it is not a mesh URL; the module is unavailable (web, iOS, an old build); the
 * node is not running; or this device has not joined the group the URL names. That last case is
 * the one worth being careful about — dialling a group we are not a member of would fail the peer
 * handshake and stall playback, where leaving the URL alone plays through the home node.
 */
export const rewriteMeshStreamUrl = (
  url: string,
  context: MeshRewriteContext,
): string => {
  if (!context.available || !context.localPort) return url;
  const target = parseMeshStreamUrl(url);
  if (!target) return url;
  if (!hasGroup(context.groups, target.group)) return url;
  return `http://127.0.0.1:${context.localPort}/stream/${target.group}/${target.itemKey}/${target.node}${target.suffix}`;
};

/** Group ids are hex; compare without case so a differently-cased pointer still matches. */
const hasGroup = (groups: readonly string[], group: string): boolean => {
  const wanted = group.toLowerCase();
  return groups.some((g) => g.toLowerCase() === wanted);
};

// --- the live context -----------------------------------------------------------------------

// Deliberately a module-level snapshot rather than a hook or a jotai atom. The rewrite happens
// inside `getStreamUrl`, which is a plain async function on the playback path with no React
// context around it, and threading one down to it would mean touching every caller. `MeshProvider`
// is the only writer.
let current: MeshRewriteContext = NOT_RUNNING;

/** Called by `MeshProvider` whenever the node starts, stops or changes its group membership. */
export const setMeshRewriteContext = (context: MeshRewriteContext): void => {
  current = {
    available: context.available,
    localPort: context.localPort,
    // Copied so a later mutation of the caller's array cannot change what the rewrite sees
    // half-way through a playback session.
    groups: [...context.groups],
  };
};

/** Forget everything, e.g. on logout. */
export const clearMeshRewriteContext = (): void => {
  current = NOT_RUNNING;
};

export const getMeshRewriteContext = (): MeshRewriteContext => current;

/**
 * Rewrite using the live context. This is what the playback and download paths call.
 *
 * Null-safe and idempotent: a URL that has already been rewritten no longer matches
 * `stingstream.local` and comes back untouched.
 */
export const rewriteStreamUrlForMesh = <T extends string | null | undefined>(
  url: T,
): T => (url ? (rewriteMeshStreamUrl(url, current) as T) : url);

/** True when this URL is one the mesh would handle, whether or not the node is running. */
export const isMeshStreamUrl = (url: string | null | undefined): boolean =>
  parseMeshStreamUrl(url) !== null;
