/**
 * What is wrong with this node's ability to fetch anything, as a pure rule.
 *
 * Split from `indexerHealth.ts` so it can be tested: `bun:test` cannot load that file's import
 * graph (`providers/JellyfinProvider` reaches a native component), the same reason
 * `downloadingApi.ts` keeps its wire half apart.
 */

export interface IndexerHealth {
  /** Indexers configured on this node, enabled or not. */
  configured: number;
  /** How many of those are switched on. */
  enabled: number;
  /** Download clients switched on. The node runs none of its own. */
  downloadClients: number;
  /** True when at least one manager answered. An empty `failing` means nothing otherwise. */
  answered: boolean;
  /** The managers' own indexer health messages. */
  failing: string[];
}

/**
 * What is wrong, if anything — the one thing worth putting on a screen.
 *
 * `null` while it is unknown, and while everything is fine. The two failures are deliberately
 * separate: "there is nowhere to search" is a thing somebody never finished setting up, and
 * "everything has stopped answering" is a thing that used to work, and the sentence a person needs
 * is not the same one.
 */
export type IndexerProblem =
  | "none-configured"
  | "no-download-client"
  | "all-failing";

export function indexerProblem(
  health: IndexerHealth | undefined,
): IndexerProblem | null {
  if (!health) return null;
  if (health.enabled === 0) return "none-configured";
  // Something to search with and nothing to send a result to: every request is found and then
  // dropped. StingStream stopped running a download client of its own on 2026-09-23.
  if (health.downloadClients === 0) return "no-download-client";
  // Only when a manager actually answered: a manager still starting has no opinion, and its
  // silence must not be read as an all-clear or as a failure.
  if (health.answered && health.failing.length > 0) return "all-failing";
  return null;
}
