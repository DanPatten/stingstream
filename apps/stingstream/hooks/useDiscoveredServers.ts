import { useCallback, useEffect, useRef, useState } from "react";
import { checkJellyfinServer } from "@/utils/jellyfin/checkServer";
import { nodeCandidates } from "@/utils/serverUrl/nodeCandidates";
import { useJellyfinDiscovery } from "./useJellyfinDiscovery";

/** A server found on this network that has been confirmed to actually answer. */
export interface DiscoveredServer {
  /** The base URL that answered, ready to hand to `setServer`. */
  url: string;
  /** The server's own name, or the one the discovery reply carried. May be empty. */
  name: string;
}

export interface DiscoveredServers {
  servers: DiscoveredServer[];
  /** True while the broadcast window is open. Replies can still be confirming after it closes. */
  searching: boolean;
  /** Broadcast again. Safe to call at any time; results accumulate rather than flicker. */
  search: () => void;
}

/**
 * "What StingStream servers are on this network?", answered rather than asked.
 *
 * This is the half of the connect screen that makes it feel like Home Assistant's: you open the
 * app and it has already found your server, and typing an address is the fallback rather than the
 * first thing you are confronted with.
 *
 * Two steps, and the second is the one that is easy to miss. A UDP discovery reply carries the
 * port the **embedded Jellyfin** is listening on, which is not the gateway port the app must
 * actually talk to — so every hit is expanded by `nodeCandidates` and probed, gateway address
 * first, and only a candidate that really answers is offered. A row you can tap that then fails
 * is worse than no row.
 *
 * Native only in practice: the broadcast goes through `react-native-udp`, which a browser cannot
 * do. On web the caller does not need this at all — the page came from the server.
 *
 * @remarks `components/login/TVServerSelectionScreen.tsx` still has its own copy of this loop.
 * Folding it in is a job for the Android/TV pass, not for a web change nobody can verify on a
 * television.
 */
export function useDiscoveredServers(): DiscoveredServers {
  const { servers: hits, isSearching, startDiscovery } = useJellyfinDiscovery();
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const probed = useRef(new Set<string>());

  const search = useCallback(() => {
    startDiscovery();
  }, [startDiscovery]);

  // Confirm each hit as it arrives rather than in a batch at the end, so the first server on the
  // network appears while the rest are still being waited for.
  useEffect(() => {
    for (const hit of hits) {
      if (probed.current.has(hit.address)) continue;
      probed.current.add(hit.address);

      (async () => {
        for (const candidate of nodeCandidates(hit.address)) {
          try {
            const result = await checkJellyfinServer(candidate);
            if (!result) continue;
            setServers((prev) =>
              prev.some((s) => s.url === result.url)
                ? prev
                : [
                    ...prev,
                    {
                      url: result.url,
                      name: result.name || hit.serverName || "",
                    },
                  ],
            );
            return;
          } catch {
            // Answered, but not usably — too old, still starting, or not a server at all. Try the
            // next candidate before giving up on this hit.
          }
        }
      })();
    }
  }, [hits]);

  return { servers, searching: isSearching, search };
}
