import {
  createStingStreamClient,
  getNodeBaseUrl,
  type StingStreamClient,
} from "@stingstream/api-client";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { apiAtom } from "@/providers/JellyfinProvider";

/**
 * Typed client for `/stingstream/api/v1/*`, memoized on the app's current
 * Jellyfin connection. `null` while there is no server connected (mirrors
 * every other `api`-dependent hook in this app, e.g. `apiAtom` itself).
 *
 * StingStream.Core's auth *is* Jellyfin's auth, and the node's gateway is the
 * same host the app is already talking to for Jellyfin (see
 * `packages/api-client/README.md`), so nothing beyond the existing Jellyfin
 * connection is needed to call it.
 */
export function useStingStreamClient(): StingStreamClient | null {
  const api = useAtomValue(apiAtom);
  return useMemo(() => {
    if (!api?.basePath) return null;
    return createStingStreamClient({
      jellyfinBasePath: api.basePath,
      accessToken: api.accessToken,
    });
  }, [api?.basePath, api?.accessToken]);
}

/** The node's gateway root (e.g. `http://192.168.1.5:8790`), or `null`. */
export function useNodeBaseUrl(): string | null {
  const api = useAtomValue(apiAtom);
  return useMemo(
    () => (api?.basePath ? getNodeBaseUrl(api.basePath) : null),
    [api?.basePath],
  );
}
