import type { MeshNodePeer } from "@/lib/stingstream/meshApi";
import { candidatesToTry, plainLanFallback } from "@/lib/stingstream/sidedoor";

/**
 * The servers to list on the Servers page: this one, and the ones it is linked to.
 *
 * Dan, looking at a page with a *THIS SERVER* card, an address hidden inside it as a sub-row, and
 * the linked servers in a separate list below: *"dont show address as a sub-thing, dont say THis
 * server - just list ALL servers with this server labeled - address listed."* So there is one list.
 * This server is a row in it like any other, marked rather than sectioned off, and the address is
 * the row's subtitle rather than a thing you open the row to find.
 *
 * Pure and tested for the reason `buildUserRows` is: which servers appear, in what order, and which
 * one is *this* one are rules, and pinning them should not need a mesh.
 */
export interface ServerRow {
  /** Node id, and the row's key. */
  node: string;
  name: string;
  /** Where a browser can reach it, or null when it has published nowhere. */
  address: string | null;
  /** This server, the one serving the page. Exactly one row has it, when it is known at all. */
  isThisServer: boolean;
  online: boolean;
  /**
   * The link this server was seen in, for the row's own settings. Null for this server, which
   * belongs to every link it has and so to none in particular.
   */
  group: string | null;
  /**
   * What this row is still waiting for, or null when it is a link that exists.
   *
   * `approval` is an administrator here who has not answered yet; `them` is an administrator over
   * there who has not accepted yet. A waiting row is not a peer and never will be until somebody
   * acts, which is exactly why it is on the list: a page that showed nothing between *Add server*
   * and the other side accepting would be a page lying about its own state.
   */
  waiting: "approval" | "them" | null;
}

/** A server that has been offered but is not a peer yet. */
export interface WaitingServer {
  /** Node id of the server that was offered. */
  node: string;
  name: string;
  /** Where a browser reaches it, or null. */
  address: string | null;
  /** `pending` here, or `approved` here and waiting for them. */
  status: "pending" | "approved";
  /** The link it was approved into, when there is one. */
  group: string | null;
}

/** Where a browser can reach a peer, preferring its own name over a plain-HTTP LAN address. */
export const peerAddress = (peer: MeshNodePeer): string | null => {
  const record = peer.sideDoor;
  if (!record) return null;
  const own = candidatesToTry(record)[0]?.url;
  // The LAN address is a real answer and worth offering, but only when nothing better exists: it
  // works on one network and says so by being plain HTTP.
  return own ?? plainLanFallback(record)?.url ?? null;
};

/**
 * One list, this server first.
 *
 * **First rather than sorted in**, because the page is about this server's links and the reader is
 * standing on it. Everything after it is by name, so the order does not shuffle as peers go on and
 * offline.
 *
 * **A peer in two links appears once.** Deduped on node id, keeping the first sighting, because a
 * server is a server however many links it shares with this one — the row is about the machine,
 * not the membership.
 *
 * **And this server appears once even before it knows its own id.** `/mesh/peers` lists this node
 * among the peers, and the id it is recognised by comes from a *different* query — so on first
 * paint there was nothing to compare against and this server was drawn twice, once labelled and
 * once as a stranger with the same name. The id decides whenever it is known; the name is the
 * fallback for the moment before, and only then, because two servers really can share a name.
 *
 * **Servers still being added come last, and only while they are still being added.** A link takes
 * two administrators to make, so there is a real interval — sometimes days, if the link went off
 * to somebody by message — when a server has been offered and is not yet a peer. It is listed,
 * greyed and labelled with what it is waiting for. The moment it joins it is a peer like any
 * other and the waiting row is deduped away by node id, so the two can never both be drawn.
 */
export function buildServerList(
  thisServer: { node: string | null; name: string; address: string | null },
  peers: readonly MeshNodePeer[] | null | undefined,
  waiting: readonly WaitingServer[] | null | undefined = [],
): ServerRow[] {
  const rows: ServerRow[] = [
    {
      node: thisServer.node ?? "this-server",
      name: thisServer.name,
      address: thisServer.address,
      isThisServer: true,
      online: true,
      group: null,
      waiting: null,
    },
  ];

  const seen = new Set<string>(
    thisServer.node ? [thisServer.node.toLowerCase()] : [],
  );
  // Only while the id is unknown. Once there is one it is the whole answer, and a peer that merely
  // shares this server's name is a different machine with a row of its own.
  const ownName = thisServer.node ? null : thisServer.name.trim().toLowerCase();

  const remote = [...(peers ?? [])]
    .filter((peer) => {
      const key = (peer.node ?? "").toLowerCase();
      if (!key || seen.has(key)) return false;
      if (ownName && (peer.serverName ?? "").trim().toLowerCase() === ownName) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map<ServerRow>((peer) => ({
      node: peer.node,
      name: peer.serverName || peer.node.slice(0, 8),
      address: peerAddress(peer),
      isThisServer: false,
      online: Boolean(peer.online),
      group: peer.group || null,
      waiting: null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const unfinished = [...(waiting ?? [])]
    .filter((server) => {
      const key = (server.node ?? "").toLowerCase();
      // A server that has joined is a peer, and a peer is the truer row: it has a live address, a
      // group and an online state, none of which a request row knows.
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map<ServerRow>((server) => ({
      node: server.node,
      name: server.name || server.node.slice(0, 8),
      address: server.address,
      isThisServer: false,
      online: false,
      group: server.group,
      waiting: server.status === "approved" ? "them" : "approval",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...rows, ...remote, ...unfinished];
}
