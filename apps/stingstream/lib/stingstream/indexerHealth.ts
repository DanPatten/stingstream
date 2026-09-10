import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { apiAtom } from "@/providers/JellyfinProvider";

/**
 * Whether this node has anywhere to search, and whether it still works.
 *
 * The gap this closes: a search on Requests comes back full of results whether or not the node can
 * fetch any of them, because those results are TMDB's. Downloading being on says a manager is
 * running; it says nothing about whether that manager has an indexer to ask. With no indexer
 * configured, or with every one of them failing, a request is accepted, looked for nowhere, and
 * simply never arrives — and the screen that took it had no way to know.
 *
 * **Plain `fetch`, not the generated client**, for the reason `downloadingApi.ts` records at
 * length: regenerating `packages/api-client/openapi.json` means running a node built from this
 * working tree, which on a shared checkout picks up whatever else is half-written. The path below
 * is pinned by `StatusController`'s route attribute. Move it onto the typed client the next time
 * that document is regenerated for other reasons.
 */

const PATH = "/status/indexers";

export interface IndexerHealth {
  /** Indexers configured on this node, enabled or not. */
  configured: number;
  /** How many of those are switched on. */
  enabled: number;
  /** True when at least one manager answered. An empty `failing` means nothing otherwise. */
  answered: boolean;
  /** The managers' own indexer health messages. */
  failing: string[];
}

/**
 * Read it whichever case it arrives in.
 *
 * Same split, same reason as `downloadingApi.ts`: these controllers are hosted inside Jellyfin and
 * its serializer PascalCases, whatever this API's own base controller documents.
 */
const toHealth = (body: unknown): IndexerHealth => {
  const raw = (body ?? {}) as Record<string, unknown>;
  const read = (key: string): unknown =>
    raw[key] ?? raw[`${key[0].toUpperCase()}${key.slice(1)}`];
  const count = (key: string): number => {
    const value = read(key);
    return typeof value === "number" ? value : 0;
  };
  const failing = read("failing");
  return {
    configured: count("configured"),
    enabled: count("enabled"),
    answered: read("answered") === true,
    failing: Array.isArray(failing) ? (failing as string[]) : [],
  };
};

/**
 * `undefined` until it is known, so a caller can hold its notice rather than flashing one.
 *
 * Elevated: `StatusController` requires it, and the notice is only offered to somebody who could
 * act on it anyway. `enabled` is the caller's own gate, so a member never sends the request.
 */
export function useIndexerHealth(enabled: boolean) {
  const api = useAtomValue(apiAtom);
  const base = api?.basePath ? getStingStreamApiBaseUrl(api.basePath) : null;
  const token = api?.accessToken ?? null;

  return useQuery({
    queryKey: ["stingstream", "indexerHealth"],
    queryFn: async (): Promise<IndexerHealth> => {
      const res = await fetch(`${base}${PATH}`, {
        headers: token
          ? { Authorization: `MediaBrowser Token="${token}"` }
          : {},
      });
      if (!res.ok) throw new Error(`GET ${PATH} failed (${res.status})`);
      return toHealth(await res.json());
    },
    enabled: enabled && !!base,
    // An indexer that has just been added, or has just come back, should stop the notice without
    // the reader reloading the screen. Slow, because nothing here changes minute to minute.
    refetchInterval: 60000,
    retry: 1,
  });
}

/**
 * What is wrong, if anything — the one thing worth putting on a screen.
 *
 * `null` while it is unknown, and while everything is fine. The two failures are deliberately
 * separate: "there is nowhere to search" is a thing somebody never finished setting up, and
 * "everything has stopped answering" is a thing that used to work, and the sentence a person needs
 * is not the same one.
 */
export type IndexerProblem = "none-configured" | "all-failing";

export function indexerProblem(
  health: IndexerHealth | undefined,
): IndexerProblem | null {
  if (!health) return null;
  if (health.enabled === 0) return "none-configured";
  // Only when a manager actually answered: a manager still starting has no opinion, and its
  // silence must not be read as an all-clear or as a failure.
  if (health.answered && health.failing.length > 0) return "all-failing";
  return null;
}
