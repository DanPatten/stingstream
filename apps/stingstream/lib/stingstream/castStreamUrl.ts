import {
  getNodeBaseUrl,
  getStingStreamApiBaseUrl,
} from "@stingstream/api-client";
import { fetchMeshGroups, fetchMeshPeers, fetchMeshStatus } from "./meshApi";
import {
  fetchDiscoveryRecord,
  nodeIdToZ32,
  raceSideDoor,
  type SideDoorKind,
  type SideDoorRecord,
  sideDoorFromDiscovery,
} from "./sidedoor";

/**
 * Chromecast over the HTTPS side door (`docs/SIDEDOOR.md`, M5 deliverable 4).
 *
 * A Chromecast receiver is exactly the client the side door exists for: it cannot speak iroh, and
 * it will only load a URL a publicly trusted certificate answers behind — so a federated item's
 * `.strm` content (`https://stingstream.local/stream/<group>/<item_key>/<node>`) cannot be handed
 * to it directly, and neither can the loopback rewrite the native player uses
 * (`utils/mesh/streamUrl.ts`) — a receiver is a *different device* and can never reach this phone's
 * `127.0.0.1`. This module is the sender-side piece: given the raw mesh URL a federated
 * `MediaSourceInfo.Path` carries, find the URL a Chromecast receiver can actually load.
 *
 * Reuses `lib/stingstream/sidedoor.ts` (M3d's racing helper) rather than reimplementing any of the
 * racing, remembering or DNS-rebinding logic — this file only does the two things that are new
 * here: turning a `/stream/...` path into a node id to look up, and finding that node's side-door
 * candidates in the first place.
 *
 * ## Where the candidates come from
 *
 * Two sources, tried in the order `docs/SIDEDOOR.md` §5 describes for the web bundle, and for the
 * same reason: the home node's own view is more likely to be fresh (it rides the gossip heartbeat)
 * and needs no coordinator round trip, but not every build of `StingStream.Core` carries the
 * `SideDoor` field yet.
 *
 * 1. **The home node's own mesh.** `GET /mesh/peers?group=` for a peer, or `GET /mesh/status` when
 *    the source node turns out to be the home node itself (a title held locally, cast to a
 *    receiver away from the LAN it would otherwise reach directly).
 * 2. **The coordinator's public discovery record**, `GET /node/v1/{node}` — works against any
 *    coordinator regardless of whether Core's build knows about `SideDoor`, at the cost of not
 *    knowing the node's mapped port (the record supplies Jellyfin's own defaults, 8790 and 443).
 *
 * When neither has anything to race — no coordinator on the group, a node with no certificate yet,
 * every candidate timing out — the fallback is the home node's own gateway, unauthenticated by
 * design for exactly this (`docs/MESH.md` §5, "This path shape is load-bearing"): the receiver asks
 * the home node for `/stream/<group>/<item_key>/<node>` and the home node's own mesh proxies it,
 * one extra hop instead of zero. That is the zero-server default working as intended, not a broken
 * state — casting from home, with no coordinator configured at all, always lands here.
 */

export interface FederatedStreamRef {
  group: string;
  itemKey: string;
  node: string;
}

const STREAM_PATH_RE = /^\/stream\/([^/]+)\/([^/]+)\/([^/]+)\/?$/;

/**
 * Pull `{group, item_key, node}` out of a federated stream URL or bare path.
 *
 * Works on the raw `stingstream.local` form and on the loopback-rewritten form alike — both carry
 * the same `/stream/...` path, and this only ever reads the path, never the host — so it does not
 * matter whether `utils/mesh/streamUrl.ts` already rewrote the URL for the native player by the
 * time a caller gets here. `null` for anything else, including an ordinary (non-federated)
 * `MediaSourceInfo.Path`, which is the common case and not an error.
 */
export function parseFederatedStreamPath(
  pathOrUrl: string,
): FederatedStreamRef | null {
  let pathname: string;
  try {
    pathname = new URL(pathOrUrl, "http://stingstream.invalid").pathname;
  } catch {
    return null;
  }
  const m = STREAM_PATH_RE.exec(pathname);
  if (!m) return null;
  return {
    group: decodeURIComponent(m[1]),
    itemKey: decodeURIComponent(m[2]),
    node: decodeURIComponent(m[3]),
  };
}

export interface CastStreamResolution {
  /** The URL to hand the receiver as `contentUrl`. */
  url: string;
  via: "sidedoor" | "home";
  kind?: SideDoorKind;
  /** Set only for the plain-HTTP LAN fallback a rebinding router forces (`sidedoor.ts`). */
  warning?: string;
}

/** Per-lookup timeout — a coordinator or a home node that is not answering must not hang "Cast". */
const DEFAULT_LOOKUP_TIMEOUT_MS = 3000;

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  onTimeoutOrError: T,
): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeoutOrError), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(onTimeoutOrError);
      },
    );
  });
}

async function findSideDoorRecord(
  ref: FederatedStreamRef,
  apiBaseUrl: string,
  accessToken: string | null | undefined,
  lookupTimeoutMs: number,
): Promise<SideDoorRecord | null> {
  // Source 1: the home node's own mesh.
  const fromHome = await withTimeout(
    (async (): Promise<SideDoorRecord | null> => {
      const peers = await fetchMeshPeers(apiBaseUrl, ref.group, accessToken);
      const peer = peers.find(
        (p) => p.node.toLowerCase() === ref.node.toLowerCase(),
      );
      if (peer?.sideDoor) return peer.sideDoor;
      const status = await fetchMeshStatus(apiBaseUrl, accessToken);
      if (
        status.node.toLowerCase() === ref.node.toLowerCase() &&
        status.sideDoor
      ) {
        return status.sideDoor;
      }
      return null;
    })().catch(() => null),
    lookupTimeoutMs,
    null,
  );
  if (fromHome) return fromHome;

  // Source 2: the coordinator's own public discovery record.
  return withTimeout(
    (async (): Promise<SideDoorRecord | null> => {
      const groups = await fetchMeshGroups(apiBaseUrl, accessToken);
      const coordinator = groups.find(
        (g) => g.group.toLowerCase() === ref.group.toLowerCase(),
      )?.coordinator;
      if (!coordinator) return null;
      const z32 = nodeIdToZ32(ref.node);
      if (!z32) return null;
      const discovery = await fetchDiscoveryRecord(coordinator, z32);
      if (!discovery) return null;
      return sideDoorFromDiscovery(discovery);
    })().catch(() => null),
    lookupTimeoutMs,
    null,
  );
}

/**
 * Resolve the URL a Chromecast receiver should load for a federated item.
 *
 * `federatedPath` is the *unrewritten* `mediaSource.Path` (or its `.Path`-shaped equivalent) —
 * pass it before anything has rewritten `stingstream.local` for the native player, or pass the
 * rewritten form; both carry the same `/stream/...` path this only reads.
 *
 * Returns `null` when `federatedPath` is not a federated mesh URL at all, which tells the caller
 * "use your normal stream-URL logic, this helper has nothing to add" rather than "casting failed" —
 * the overwhelming majority of casts are ordinary local items and must not pay for a mesh lookup.
 */
export async function resolveCastStreamUrl(params: {
  jellyfinBasePath: string;
  accessToken?: string | null;
  federatedPath: string;
  raceTimeoutMs?: number;
  lookupTimeoutMs?: number;
}): Promise<CastStreamResolution | null> {
  const ref = parseFederatedStreamPath(params.federatedPath);
  if (!ref) return null;

  const nodeBaseUrl = getNodeBaseUrl(params.jellyfinBasePath);
  const apiBaseUrl = getStingStreamApiBaseUrl(params.jellyfinBasePath);
  const suffix = `/stream/${encodeURIComponent(ref.group)}/${encodeURIComponent(ref.itemKey)}/${encodeURIComponent(ref.node)}`;
  const homeFallback: CastStreamResolution = {
    url: `${nodeBaseUrl}${suffix}`,
    via: "home",
  };

  const record = await findSideDoorRecord(
    ref,
    apiBaseUrl,
    params.accessToken,
    params.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS,
  ).catch(() => null);
  if (!record || record.candidates.length === 0) return homeFallback;

  const choice = await raceSideDoor(record, {
    timeoutMs: params.raceTimeoutMs,
  }).catch(() => null);
  if (!choice) return homeFallback;

  return {
    url: `${choice.url}${suffix}`,
    via: "sidedoor",
    kind: choice.kind,
    warning: choice.warning,
  };
}
