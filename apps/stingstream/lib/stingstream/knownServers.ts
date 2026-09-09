import { storage } from "@/utils/mmkv";
import {
  raceSideDoor,
  type SideDoorCandidate,
  type SideDoorChoice,
  type SideDoorRecord,
} from "./sidedoor";

/**
 * The servers this client knows how to reach, and how to get to one when the one it was using is
 * down.
 *
 * ## Why this exists
 *
 * Dan, having deleted the address box:
 *
 * > *"there is NO other server, if the server is down for whatever reason the client should be
 * > smart. if the server the client is connecting to is DOWN then it should attempt hitting ANY
 * > other servers the user's target server is linked to instead, the client stores those domains…
 * > and automatically routes to the first one that's up… no need to ever enter in an address
 * > manually."*
 *
 * So the address book is **learned, not typed**. While signed in, the app records where its own
 * server and every server that one is linked to can be reached; when its origin does not answer on
 * a cold load, it races that list and goes to the winner.
 *
 * ## The constraint that shapes it
 *
 * Everything the app knows about linked servers is behind a session — `lib/stingstream/mesh.ts`
 * gates the peer queries on a user id, deliberately, because auto-connect otherwise put a pair of
 * red 401s in the login screen's own console. A signed-out client looking at a dead server cannot
 * ask anybody anything. **That is why this is a cache and not a query.**
 */

/** Where the list lives. One key, one JSON array, small enough to read synchronously at boot. */
const STORAGE_KEY = "stingstream.knownServers";

/**
 * How many servers to remember.
 *
 * A group is a handful of friends' machines. The cap exists so a long-lived install with a churning
 * group does not accumulate an address book it will spend timeouts racing.
 */
export const MAX_KNOWN_SERVERS = 12;

/**
 * How long a server nobody has seen is still worth trying.
 *
 * Long, because the case this serves is "my server has been off for a week and I want to watch
 * something", and short enough that a machine that left the group a year ago stops costing a
 * timeout.
 */
export const KNOWN_SERVER_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface KnownServer {
  /** The node id. The identity a race verifies against, and the key entries are merged on. */
  nodeId: string;
  /** For "Trying Dan's Attic…". May be empty when the peer never told us. */
  name: string;
  record: SideDoorRecord;
  /** ISO 8601. When this entry was last confirmed by a server that was answering. */
  lastSeen: string;
}

/** Whether a candidate is a real domain rather than a private address over plain HTTP. */
const isPublic = (c: SideDoorCandidate): boolean => c.kind !== "lan-ip-http";

/**
 * Order servers the way Dan asked: **public first, then LAN**.
 *
 * A domain works from anywhere, so it is tried first and the common case — away from home, own
 * server down — costs one round trip. The LAN entries are what make a second node in the same
 * house a working fallback for a household where nobody has a domain, which is most of them.
 *
 * Within each half, most recently seen first: the server that was up an hour ago is a better guess
 * than one last seen in March.
 */
export function orderKnownServers(servers: KnownServer[]): KnownServer[] {
  const rank = (s: KnownServer) => (s.record.candidates.some(isPublic) ? 0 : 1);
  return [...servers].sort(
    (a, b) => rank(a) - rank(b) || b.lastSeen.localeCompare(a.lastSeen),
  );
}

/** Drop entries nothing has seen in a long time, and anything with nowhere to go. */
export function pruneKnownServers(
  servers: KnownServer[],
  now: number = Date.now(),
): KnownServer[] {
  return servers.filter((s) => {
    if (s.record.candidates.length === 0) return false;
    const seen = Date.parse(s.lastSeen);
    return !Number.isFinite(seen) || now - seen < KNOWN_SERVER_TTL_MS;
  });
}

/**
 * Fold newly-seen servers into what is already remembered.
 *
 * Newer wins per node id, because a record is a snapshot of where a node was and the fresher one is
 * the truth. Everything else is kept: a peer that is offline right now is exactly the peer this
 * list exists to remember.
 */
export function mergeKnownServers(
  existing: KnownServer[],
  seen: KnownServer[],
  now: number = Date.now(),
): KnownServer[] {
  const byNode = new Map<string, KnownServer>();
  for (const server of [...existing, ...seen]) {
    if (!server.nodeId || server.record.candidates.length === 0) continue;
    const previous = byNode.get(server.nodeId);
    if (!previous || previous.lastSeen <= server.lastSeen) {
      byNode.set(server.nodeId, server);
    }
  }
  return orderKnownServers(pruneKnownServers([...byNode.values()], now)).slice(
    0,
    MAX_KNOWN_SERVERS,
  );
}

/** What is remembered, or an empty list. Never throws: this runs on the boot path. */
export function readKnownServers(): KnownServer[] {
  try {
    const raw = storage.getString(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is KnownServer =>
        !!s &&
        typeof s === "object" &&
        typeof (s as KnownServer).nodeId === "string" &&
        Array.isArray((s as KnownServer).record?.candidates),
    );
  } catch {
    return [];
  }
}

/** Replace what is remembered. Silent on failure — a full disk must not break signing in. */
export function writeKnownServers(servers: KnownServer[]): void {
  try {
    storage.set(STORAGE_KEY, JSON.stringify(servers));
  } catch {
    // Nothing to do and nothing worth saying: the list is a convenience.
  }
}

/** Record what a working server told us about itself and its group. */
export function rememberServers(seen: KnownServer[]): KnownServer[] {
  const merged = mergeKnownServers(readKnownServers(), seen);
  writeKnownServers(merged);
  return merged;
}

export interface LiveServer {
  server: KnownServer;
  choice: SideDoorChoice;
}

/**
 * The first remembered server that answers.
 *
 * Tried in order rather than all at once, so a working domain is used immediately instead of after
 * every dead one has timed out — and so the LAN entries, which are the downgrade, are only reached
 * when nothing better answered.
 *
 * `raceSideDoor` does the per-server work and is where the important guarantee lives: it verifies
 * the node id in the reply, so a hostile DNS answer for a remembered domain cannot pass itself off
 * as a linked server.
 */
export async function findLiveServer(
  servers: KnownServer[],
  opts: { exceptOrigin?: string; timeoutMs?: number } = {},
): Promise<LiveServer | null> {
  const except = opts.exceptOrigin?.replace(/\/+$/, "").toLowerCase();
  for (const server of orderKnownServers(pruneKnownServers(servers))) {
    // The server we are here *because* it is down. Racing it again is a guaranteed timeout, and it
    // is matched on the **candidate URL** rather than the node id: what the caller has at this
    // point is the origin its page was served from, not an identity — the marker that would have
    // carried one is exactly what a dead server did not send.
    if (
      except &&
      server.record.candidates.some(
        (c) => c.url.replace(/\/+$/, "").toLowerCase() === except,
      )
    ) {
      continue;
    }
    const choice = await raceSideDoor(server.record, {
      timeoutMs: opts.timeoutMs,
    });
    if (choice) return { server, choice };
  }
  return null;
}
