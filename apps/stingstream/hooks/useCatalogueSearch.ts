import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import {
  type CatalogueSections,
  fetchRequests,
  searchRequestable,
  splitCatalogueResults,
} from "@/lib/stingstream/requestsApi";
import { apiAtom } from "@/providers/JellyfinProvider";

/**
 * Two characters is the floor.
 *
 * Every call is two metadata lookups on the node, and one character matches everything ever made —
 * but two is a real search ("Up", "It", "Us" are all films somebody will type), so the cut is
 * *below* two rather than at three.
 */
export const CATALOGUE_MIN_QUERY_LENGTH = 2;

/** One minute. A film does not stop existing while the user reads the results. */
const CATALOGUE_STALE_MS = 60_000;

/**
 * The keys `lib/stingstream/requests.ts` builds for the same two queries, spelled out here so the
 * two callers share one cache entry — and, more importantly, so `useCreateRequest`'s
 * `invalidateQueries(["stingstream", "requests"])` reaches these as well. That invalidation is what
 * turns a card from "Request" into "Requested" the moment the sheet closes.
 */
const SEARCH_KEY = (term: string) =>
  ["stingstream", "requests", "search", term, null] as const;
const MINE_KEY = ["stingstream", "requests", "list", true, null] as const;

export interface CatalogueSearch extends CatalogueSections {
  /** An answer for this term is in flight and there is nothing to show yet. */
  loading: boolean;
  /**
   * There is nothing to draw and nothing to say: no node connected, the term is too short, or the
   * call failed. The screen renders no section at all in that case — a server without the requests
   * feature must not grow an error box on its search results.
   */
  unavailable: boolean;
}

/**
 * The catalogue half of Search: what TMDB and TheTVDB know that this server does not hold.
 *
 * Gated on a connected node, which is the same condition `useStingStreamClient()` reports (both are
 * `apiAtom`'s `basePath`) — the calls themselves go through `requestsApi`'s plain fetch rather than
 * the typed client, because that is where the 503 rule lives: a node without the requests feature
 * answers "not set up" rather than an empty list, and the two mean opposite things.
 *
 * The member's own requests are fetched alongside, off the *same* key the Requests screen polls, so
 * a title already asked for shows its "Requested" pill here without waiting for the node's search
 * annotation to catch up. Deliberately without `refetchInterval`: the Requests screen owns the
 * polling, and a search box has no business keeping a timer alive.
 *
 * Both queries retry once and then give up, per the loading rules in `docs/UI-DESIGN.md`: this is
 * an *addition* to results the user can already see, so a failure is worth one more try and no more.
 */
export function useCatalogueSearch(
  term: string,
  libraryKeys: ReadonlySet<string>,
): CatalogueSearch {
  const api = useAtomValue(apiAtom);
  const base = api?.basePath ? getStingStreamApiBaseUrl(api.basePath) : null;
  const token = api?.accessToken ?? null;
  const trimmed = term.trim();
  const enabled = !!base && trimmed.length >= CATALOGUE_MIN_QUERY_LENGTH;

  const search = useQuery({
    queryKey: SEARCH_KEY(trimmed),
    // `base` is non-null whenever the query runs; `enabled` is the guard.
    queryFn: () => searchRequestable(base as string, trimmed, undefined, token),
    enabled,
    staleTime: CATALOGUE_STALE_MS,
    retry: 1,
  });

  const mine = useQuery({
    queryKey: MINE_KEY,
    queryFn: () => fetchRequests(base as string, { mine: true }, token),
    enabled,
    staleTime: CATALOGUE_STALE_MS,
    retry: 1,
  });

  const results = search.data;
  const sections = useMemo(
    () => splitCatalogueResults(results ?? [], libraryKeys, mine.data ?? []),
    [results, libraryKeys, mine.data],
  );

  return {
    ...sections,
    loading: enabled && search.isFetching && !results,
    unavailable: !enabled || !!search.error,
  };
}
