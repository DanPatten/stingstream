import { useEffect } from "react";
import {
  type KnownServer,
  rememberServers,
} from "@/lib/stingstream/knownServers";
import { useNodeMeshPeers, useNodeMeshStatus } from "@/lib/stingstream/mesh";

/**
 * Remember where this server and the servers it is linked to can be reached.
 *
 * Written while signed in, read at boot by a client whose own server is not answering — see
 * `lib/stingstream/knownServers.ts` for why it has to work that way round, and for Dan's
 * description of what it is for.
 *
 * This is a **writer with no return value**: nothing renders from it. It is mounted once, high up,
 * and the queries it uses are already polled for other screens, so it costs no extra requests.
 */
export function useKnownServers(): void {
  const { data: status } = useNodeMeshStatus();
  // Every group, not one: the point is the whole address book, and a client that has to pick a
  // group before it can fall back has not solved anything.
  const { data: peers } = useNodeMeshPeers(null);

  useEffect(() => {
    const seen: KnownServer[] = [];
    const at = new Date().toISOString();

    // This server first. Its own record is the one a client is most likely to need again — a
    // browser that lands on a different linked server still wants to be able to come home.
    if (status?.sideDoor?.candidates?.length) {
      seen.push({
        nodeId: status.node,
        name: status.serverName ?? "",
        record: status.sideDoor,
        lastSeen: at,
      });
    }

    for (const peer of peers ?? []) {
      // A peer with no domain and no LAN address publishes nothing, and there is nothing to
      // remember about it. That is most peers until somebody points a domain at one.
      if (!peer.sideDoor?.candidates?.length) continue;
      seen.push({
        nodeId: peer.node,
        name: peer.serverName ?? "",
        record: peer.sideDoor,
        // A peer that is offline right now still had its address published at some point, and
        // that address is exactly what this list is for. `lastSeen` records when *we* saw the
        // record, not when the peer was last up.
        lastSeen: at,
      });
    }

    if (seen.length > 0) rememberServers(seen);
  }, [status, peers]);
}
