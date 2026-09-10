import type {
  NetworkConfiguration,
  ServerConfiguration,
} from "@jellyfin/sdk/lib/generated-client/models";
import { getConfigurationApi } from "@jellyfin/sdk/lib/utils/api";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { apiAtom } from "@/providers/JellyfinProvider";

/**
 * Jellyfin's own server configuration, for the settings panes that edit it.
 *
 * These go through `/jellyfin/*` rather than StingStream.Core: ports, base URL,
 * reverse proxies, certificates, transcode ceilings and library scanning are
 * genuine Jellyfin server-admin features, and `docs/UI.md` §"How data flows"
 * says an admin screen calls the Jellyfin SDK directly against the same
 * `apiAtom` every other screen uses. `TranscodingSection` already did exactly
 * this for the encoding document; this file is the same pattern named once, now
 * that three panes need it.
 *
 * **Always send the whole document back.** Both endpoints replace rather than
 * patch, so a partial body silently resets every field it does not name to its
 * C# default — a bug caught in this repo once already, in `ui-startup.ps1`'s
 * `LibraryOptions` call (see `docs/UI-LOOP.md`). Every hook here reads, drafts
 * and writes the complete object for that reason.
 */

export const JELLYFIN_CONFIG_QUERY_KEY = [
  "stingstream",
  "jellyfin-config",
] as const;

/** The whole-server document: bitrate ceilings, library scanning, paths. */
export function useServerConfiguration(): UseQueryResult<ServerConfiguration> {
  const api = useAtomValue(apiAtom);
  return useQuery({
    queryKey: [...JELLYFIN_CONFIG_QUERY_KEY, "server"],
    queryFn: async () =>
      (await getConfigurationApi(api!).getConfiguration()).data,
    enabled: !!api,
  });
}

export function useUpdateServerConfiguration() {
  const api = useAtomValue(apiAtom);
  const queryClient = useQueryClient();
  return useMutation<void, Error, ServerConfiguration>({
    mutationFn: async (next) => {
      await getConfigurationApi(api!).updateConfiguration({
        serverConfiguration: next,
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [...JELLYFIN_CONFIG_QUERY_KEY, "server"],
      }),
  });
}

/**
 * The network document: ports, base URL, HTTPS, known proxies, UPnP.
 *
 * Typed here rather than at the call site because the generated client declares
 * `getNamedConfiguration` as returning a `File` — it is one endpoint serving
 * every named document, so the generator had no better answer — and every
 * caller would otherwise repeat the same cast.
 */
export function useNetworkConfiguration(): UseQueryResult<NetworkConfiguration> {
  const api = useAtomValue(apiAtom);
  return useQuery({
    queryKey: [...JELLYFIN_CONFIG_QUERY_KEY, "network"],
    queryFn: async () => {
      const res = await getConfigurationApi(api!).getNamedConfiguration({
        key: "network",
      });
      return res.data as unknown as NetworkConfiguration;
    },
    enabled: !!api,
  });
}

export function useUpdateNetworkConfiguration() {
  const api = useAtomValue(apiAtom);
  const queryClient = useQueryClient();
  return useMutation<void, Error, NetworkConfiguration>({
    mutationFn: async (next) => {
      await getConfigurationApi(api!).updateNamedConfiguration({
        key: "network",
        body: next,
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [...JELLYFIN_CONFIG_QUERY_KEY, "network"],
      }),
  });
}

/**
 * A comma-separated field and a `string[]` in the document.
 *
 * `KnownProxies`, `LocalNetworkSubnets` and friends are lists, and the app has
 * no list editor for a handful of short strings. One field, split on commas,
 * trimmed, empties dropped — which also means clearing the field means "none"
 * rather than "one empty entry", the shape that got a reverse proxy silently
 * distrusted.
 */
export const parseList = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const formatList = (value: string[] | null | undefined): string =>
  (value ?? []).join(", ");
