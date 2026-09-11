import { getSystemApi } from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { looksLikeHostname } from "@/lib/stingstream/setup";
import { apiAtom } from "@/providers/JellyfinProvider";
import { useNodeContext } from "./useNodeContext";

export const SERVER_NAME_QUERY_KEY = ["stingstream", "server-name"] as const;

/**
 * What this server is called, from the server itself.
 *
 * **The page marker is a placeholder, not the answer.** `window.__STINGSTREAM_NODE__.serverName` is
 * spliced into the HTML at serve time from the `runtime.json` the gateway read when it started, so
 * it is the value most likely to be stale — and it was stale for exactly the person who had just
 * renamed their server during setup. Dan, on the sidebar: *"why is this server name still ui-loop
 * instead of what I named the server"*. It was, and it would have been until the node restarted.
 *
 * Jellyfin's `PublicSystemInfo.ServerName` is what setup writes and is correct at once, so it wins
 * and the marker holds the line until it answers.
 *
 * `looksLikeHostname` still guards it, for the case that reasoning was originally built for: a
 * server whose configuration was reset reports its machine name, and "PLEXPC" is never worth
 * showing anybody.
 */
export function useServerName(): string | undefined {
  const api = useAtomValue(apiAtom);
  const nodeContext = useNodeContext();

  const { data } = useQuery({
    queryKey: [...SERVER_NAME_QUERY_KEY, api?.basePath],
    queryFn: async () => {
      const info = await getSystemApi(api!).getPublicSystemInfo();
      return info.data.ServerName ?? "";
    },
    enabled: !!api?.basePath,
    // It changes when somebody renames the server, which is rare and deliberate; anything more
    // eager is a request per screen for a string that has not moved since first run.
    staleTime: 5 * 60_000,
  });

  const reported = data?.trim();
  if (reported && !looksLikeHostname(reported)) return reported;

  const marker = nodeContext?.serverName?.trim();
  return marker && marker.length > 0 ? marker : undefined;
}
