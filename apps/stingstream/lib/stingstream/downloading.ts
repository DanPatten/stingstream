import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { apiAtom } from "@/providers/JellyfinProvider";
import {
  CHILD_FOR,
  type DownloadingKey,
  type DownloadingSettings,
  fetchDownloading,
  saveDownloading,
} from "./downloadingApi";
import { useHealthz } from "./status";

/**
 * React Query over the downloading switch.
 *
 * The types and the plain-fetch half live in `./downloadingApi` and are re-exported below, so a
 * non-React caller — and `bun:test` — never has to come through here. Same split as
 * `requests.ts` / `requestsApi.ts`.
 */

export * from "./downloadingApi";

function useConnection() {
  const api = useAtomValue(apiAtom);
  const base = api?.basePath ? getStingStreamApiBaseUrl(api.basePath) : null;
  return { base, token: api?.accessToken ?? null };
}

const KEY = ["stingstream", "downloading"] as const;

/** The switch position, as `config.toml` currently reads. */
export function useDownloading() {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: KEY,
    queryFn: () => fetchDownloading(base!, token),
    enabled: !!base,
    // The file can also be edited by hand on the server, and the supervisor acts on that. Polling
    // slowly means a screen left open does not quietly disagree with the node.
    refetchInterval: 30000,
    retry: 1,
  });
}

/**
 * What is actually running, per `/healthz`.
 *
 * `undefined` while healthz is still loading, so a caller can tell "not started yet" from "not
 * running" — the difference between a spinner and a problem.
 */
export function useDownloadingHealth(key: DownloadingKey): {
  running: boolean | undefined;
  state: string | undefined;
  error: string | undefined;
} {
  const healthz = useHealthz();
  const child = healthz.data?.children.find((c) => c.name === CHILD_FOR[key]);
  // `redacted` for the same reason as the loading case: a node answering from
  // off its own machine does not list its children, so there is nothing to
  // report and a pill claiming "Not running" would be inventing one.
  if (!healthz.data || healthz.data.redacted) {
    return { running: undefined, state: undefined, error: undefined };
  }
  return {
    running: child?.state === "healthy" || child?.state === "starting",
    state: child?.state,
    // The supervisor puts its refusal here — a manager whose binary is missing, most often — and
    // it is the only place that says *why* a switch that is on has nothing behind it.
    error: child?.last_error ?? undefined,
  };
}

export function useSaveDownloading() {
  const { base, token } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: DownloadingSettings) =>
      saveDownloading(base!, settings, token),
    onSuccess: (saved) => {
      // The switch answers immediately from what the node confirmed it wrote; the *running* half
      // catches up on the healthz poll a few seconds later.
      queryClient.setQueryData(KEY, saved);
      queryClient.invalidateQueries({ queryKey: ["stingstream"] });
    },
  });
}
