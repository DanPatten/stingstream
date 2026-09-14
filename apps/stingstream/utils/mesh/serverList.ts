import type { ConnectionRequestSummary } from "@/lib/stingstream/connections";
import type { MeshNodeGroup, MeshNodePeer } from "@/lib/stingstream/meshApi";
import { candidatesToTry, plainLanFallback } from "@/lib/stingstream/sidedoor";

/**
 * The rows on the Servers page: this server, the servers it is connected to, the invitations
 * nobody has opened yet, and the requests waiting for an administrator.
 *
 * Dan, looking at a page with a *THIS SERVER* card, an address hidden inside it as a sub-row, and
 * the linked servers in a separate list below: *"dont show address as a sub-thing, dont say THis
 * server - just list ALL servers with this server labeled - address listed."* So there is one list.
 *
 * Pure and tested for the reason `buildUserRows` is: which servers appear, in what order, and which
 * one is *this* one are rules, and pinning them should not need a mesh.
 */
export interface ServerRow {
  /** The row's key: a node id, a group id or a request id. */
  key: string;
  name: string;
  /** Where a browser can reach it, or null when it has published nowhere. */
  address: string | null;
  /** This server, the one serving the page. Exactly one row has it. */
  isThisServer: boolean;
  online: boolean;
  /** The connection this row is, for its own page. Null for this server and for requests. */
  group: string | null;
  /**
   * What this row is still waiting for, or null when it is a connection that exists.
   *
   * `invitation` is an invite link this server made that nobody has used. `request` is an invite
   * link from another server waiting for an administrator here.
   */
  pending: "invitation" | "request" | null;
  /** The request, for `pending === "request"`. */
  request: ConnectionRequestSummary | null;
  /** When an invitation was made, for `pending === "invitation"`. */
  createdAt: string | null;
}

/** Where a browser can reach a peer, preferring its own name over a plain-HTTP LAN address. */
export const peerAddress = (peer: MeshNodePeer): string | null => {
  // Saved for the connection: from the invite link, or typed when the server moved. It wins,
  // because it exists precisely where the announced one is missing or wrong.
  if (peer.address) return peer.address;
  const record = peer.sideDoor;
  if (!record) return null;
  const own = candidatesToTry(record)[0]?.url;
  // The LAN address is a real answer and worth offering, but only when nothing better exists: it
  // works on one network and says so by being plain HTTP.
  return own ?? plainLanFallback(record)?.url ?? null;
};

/**
 * The groups this server made that no other server has joined: invitations nobody has opened.
 *
 * A group with any member but this node is a connection, however long that member has been away.
 * Null for this node's id means the question cannot be answered yet, and the answer is none rather
 * than every group.
 */
export function pendingInvitations(
  groups: readonly MeshNodeGroup[] | null | undefined,
  peers: readonly MeshNodePeer[] | null | undefined,
  thisNode: string | null | undefined,
): MeshNodeGroup[] {
  if (!thisNode) return [];
  const me = thisNode.toLowerCase();
  const joined = new Set(
    (peers ?? [])
      .filter((peer) => (peer.node ?? "").toLowerCase() !== me)
      .map((peer) => peer.group),
  );
  return (groups ?? []).filter((group) => !joined.has(group.group));
}

/**
 * One list, this server first.
 *
 * **First rather than sorted in**, because the page is about this server's connections and the
 * reader is standing on it. Connected servers follow by name, so the order does not shuffle as
 * peers go on and offline; then requests, then invitations, oldest first.
 *
 * **A peer in two groups appears once**, deduped on node id: the row is about the machine.
 *
 * **This server appears once even before it knows its own id.** `/mesh/peers` lists this node among
 * the peers, and the id it is recognised by comes from a different query; until it lands, the name
 * is the fallback, and only then, because two servers really can share a name.
 *
 * **A request from a server already connected is not listed.** It can only have been brought twice,
 * and the connection is the truer row.
 */
export function buildServerList(
  thisServer: { node: string | null; name: string; address: string | null },
  peers: readonly MeshNodePeer[] | null | undefined,
  invitations: readonly MeshNodeGroup[] | null | undefined = [],
  requests: readonly ConnectionRequestSummary[] | null | undefined = [],
): ServerRow[] {
  const base = {
    online: false,
    group: null,
    pending: null,
    request: null,
    createdAt: null,
  } as const;

  const rows: ServerRow[] = [
    {
      ...base,
      key: thisServer.node ?? "this-server",
      name: thisServer.name,
      address: thisServer.address,
      isThisServer: true,
      online: true,
    },
  ];

  const seen = new Set<string>(
    thisServer.node ? [thisServer.node.toLowerCase()] : [],
  );
  const ownName = thisServer.node ? null : thisServer.name.trim().toLowerCase();

  const connected = [...(peers ?? [])]
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
      ...base,
      key: peer.node,
      name: peer.serverName || peer.node.slice(0, 8),
      address: peerAddress(peer),
      isThisServer: false,
      online: Boolean(peer.online),
      group: peer.group || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const waiting = [...(requests ?? [])]
    .filter((request) => {
      const key = (request.node ?? "").toLowerCase();
      return !key || !seen.has(key);
    })
    .map<ServerRow>((request) => ({
      ...base,
      key: `request:${request.id}`,
      name: request.serverName || request.node.slice(0, 8),
      address: null,
      isThisServer: false,
      pending: "request",
      request,
    }));

  const unopened = [...(invitations ?? [])]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map<ServerRow>((group) => ({
      ...base,
      key: `invitation:${group.group}`,
      name: "",
      address: null,
      isThisServer: false,
      group: group.group,
      pending: "invitation",
      createdAt: group.createdAt || null,
    }));

  return [...rows, ...connected, ...waiting, ...unopened];
}
