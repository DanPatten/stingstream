import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import {
  type CreateRequestInput,
  createRequest,
  decideRequest,
  deleteRequest,
  discoverQuery,
  discoverRequestable,
  fetchCredits,
  fetchNotifications,
  fetchRelated,
  fetchRequest,
  fetchRequestCounts,
  fetchRequestPolicy,
  fetchRequests,
  fetchRequestsAvailable,
  fetchRequestUsers,
  type MemberRequest,
  markNotificationsRead,
  type RequestFilterState,
  type RequestPolicy,
  type RequestState,
  type RequestsMode,
  saveRequestPolicy,
  saveRequestUser,
  searchRequestable,
  setRequestSeasons,
} from "./requestsApi";

/**
 * React Query over `/stingstream/api/v1/requests/*` (M6).
 *
 * The types and the plain-fetch functions live in `./requestsApi` and are re-exported below, so a
 * non-React caller — and `bun:test`, which cannot load `providers/JellyfinProvider`'s import graph
 * — never has to come through here. Same split as `mesh.ts` / `meshApi.ts`.
 *
 * **Elevation.** Searching, requesting, and reading your own requests need only a Jellyfin account.
 * Approving, declining, retrying, the policy and the trust list are `RequiresElevation`; the screens
 * hide those rather than offering a button that answers 403.
 */

export * from "./requestsApi";

const keys = {
  all: ["stingstream", "requests"] as const,
  list: (mine: boolean | undefined, state: RequestState | undefined) =>
    ["stingstream", "requests", "list", mine ?? null, state ?? null] as const,
  detail: (id: string) => ["stingstream", "requests", "detail", id] as const,
  counts: ["stingstream", "requests", "counts"] as const,
  available: ["stingstream", "requests", "available"] as const,
  policy: (group: string | undefined) =>
    ["stingstream", "requests", "policy", group ?? null] as const,
  users: ["stingstream", "requests", "users"] as const,
  search: (term: string, kind: string | undefined) =>
    ["stingstream", "requests", "search", term, kind ?? null] as const,
  discover: (query: Record<string, string>) =>
    ["stingstream", "requests", "discover", query] as const,
  related: (itemId: string) =>
    ["stingstream", "requests", "related", itemId] as const,
  credits: (personId: string) =>
    ["stingstream", "requests", "credits", personId] as const,
  notifications: (unreadOnly: boolean) =>
    ["stingstream", "requests", "notifications", unreadOnly] as const,
};

/** The node's StingStream API root and the token, or nulls before a server is connected. */
/**
 * Keep this answer out of the persisted cache, but not out of memory.
 *
 * A request moves through pending, downloading and available on its own, without anybody touching
 * this app. `app/_layout.tsx` writes every successful query to MMKV for 24 hours, so without this
 * the screen opens on whatever was true when it was last looked at — "Downloading" over a film
 * that landed last night — and corrects itself once the network answers. On a server across the
 * internet rather than a laptop, that correction is the visible flicker.
 *
 * Not `gcTime: 0`, which is the other way out and a heavier one: it would also drop the query the
 * moment the screen unmounts, so every return to the tab would start from a skeleton. The point
 * here is only that yesterday's answer must not survive a reload.
 */
const LIVE = { persist: false } as const;

function useConnection() {
  const api = useAtomValue(apiAtom);
  const base = api?.basePath ? getStingStreamApiBaseUrl(api.basePath) : null;
  return { base, token: api?.accessToken ?? null };
}

/** Whether the signed-in user administers this node. Mirrors `useIsStingStreamAdmin`. */
export function useCanApproveRequests(): boolean {
  const user = useAtomValue(userAtom);
  return !!user?.Policy?.IsAdministrator;
}

/** The signed-in user's Jellyfin id, for telling their own requests from everybody else's. */
export function useCurrentUserId(): string | undefined {
  const user = useAtomValue(userAtom);
  return user?.Id;
}

export function useRequests(
  options: { mine?: boolean; state?: RequestState } = {},
) {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.list(options.mine, options.state),
    queryFn: () => fetchRequests(base!, options, token),
    enabled: !!base,
    meta: LIVE,
    // Ten seconds, matching the node's own fulfilment pass. Polling faster would only show the
    // same row again; polling slower would leave "Downloading" on screen after it had landed.
    refetchInterval: 10000,
    // A failed list gets one automatic retry, then the screen's own Retry button — not the
    // client's default three, which would leave a spinner up for several seconds before a screen
    // that has already failed finally says so.
    retry: 1,
  });
}

export function useRequest(id: string | undefined) {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.detail(id ?? ""),
    queryFn: () => fetchRequest(base!, id!, token),
    enabled: !!base && !!id,
    refetchInterval: 10000,
    meta: LIVE,
  });
}

/**
 * Whether requests are set up on this node at all — the gate the whole screen sits behind.
 *
 * `gcTime: 0` is the load-bearing line, and it is there to keep this answer *out* of the persisted
 * cache: `app/_layout.tsx` dehydrates every successful query into MMKV for 24 hours and skips only
 * the ones with `gcTime: 0`. Turning a manager on means editing the node's `config.toml` and
 * restarting it, so the very moment this answer changes is the moment a persisted copy of the old
 * one would be read back — an administrator who had just set the managers up would be told for the
 * rest of the day that they had not. Caught exactly that way in testing, against a node whose
 * plugin was upgraded under a browser that had already cached "available".
 *
 * `staleTime` then keeps it to one round trip per visit rather than one per section render, and
 * `retry: false` because an unset-up node answers 503 immediately and truthfully — a node that
 * cannot be reached at all is treated as available (see `fetchRequestsAvailable`), so there is
 * nothing a second attempt could improve.
 */
export function useRequestsAvailable() {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.available,
    queryFn: () => fetchRequestsAvailable(base!, token),
    enabled: !!base,
    staleTime: 60000,
    gcTime: 0,
    retry: false,
  });
}

export function useRequestCounts(options: { enabled?: boolean } = {}) {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.counts,
    queryFn: () => fetchRequestCounts(base!, token),
    enabled: (options.enabled ?? true) && !!base,
    refetchInterval: 30000,
    // A badge that is wrong is worse than a badge that is a moment late: it sends somebody to a
    // screen to answer approvals that were answered yesterday.
    meta: LIVE,
    // A badge is a nicety. One failed poll must not put an error state in the tab bar.
    retry: 1,
  });
}

/**
 * Whether this group fulfils requests on its own, or by somebody adding the file.
 *
 * Shares `useRequestCounts`' query and key, so a screen already polling counts pays nothing for
 * this. `undefined` while it is still being fetched, which callers must hold the current UI for
 * rather than guessing: flickering an approval queue in and straight back out is worse than a
 * moment of nothing.
 */
export function useRequestsMode(enabled = true): RequestsMode | undefined {
  return useRequestCounts({ enabled }).data?.requestsMode;
}

/**
 * Search, debounced by the caller.
 *
 * `enabled` on a term of two characters or fewer: every keystroke here is two metadata lookups on
 * the node and a group-index scan per result, and "th" matches everything ever made.
 */
export function useRequestSearch(term: string, kind?: "movie" | "series") {
  const { base, token } = useConnection();
  const trimmed = term.trim();
  return useQuery({
    queryKey: keys.search(trimmed, kind),
    queryFn: () => searchRequestable(base!, trimmed, kind, token),
    enabled: !!base && trimmed.length > 2,
    staleTime: 60000,
    retry: 1,
  });
}

/**
 * The catalogue: what is popular now, or the best ever made, narrowed by the bar above it.
 *
 * `keepPreviousData` is the point of this being a query rather than a fetch on press. Pressing a
 * genre chip re-asks the node, and without it the grid would empty and re-fill on every press,
 * which reads as the screen breaking rather than as it answering.
 *
 * The stale window is long because the answer is: the most popular titles do not move between one
 * glance at the screen and the next, and the node caches the upstream call for longer still.
 */
export function useRequestDiscover(state: RequestFilterState, page = 1) {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.discover(discoverQuery(state, page)),
    queryFn: () => discoverRequestable(base!, state, page, token),
    enabled: !!base,
    staleTime: 30 * 60000,
    placeholderData: keepPreviousData,
    retry: 1,
  });
}

/**
 * What else is like this, whoever holds it.
 *
 * `enabled` carries the caller's own gate as well as the id, because every one of these rows is
 * drawn behind `useRequestsAvailable`: a node that cannot read the catalogue answers 503 and the
 * screen falls back to its library-only row rather than asking this at all.
 *
 * The stale window matches the catalogue's, and for the same reason: a film's recommendations do
 * not move between two glances at its page, and the node caches the upstream call for six hours
 * anyway. Deliberately not `meta: LIVE` -- this is a catalogue answer, and persisting it is right,
 * unlike a request's own state.
 */
export function useRelatedTitles(
  itemId: string | null | undefined,
  enabled = true,
) {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.related(itemId ?? ""),
    queryFn: () => fetchRelated(base!, { itemId }, token),
    enabled: enabled && !!base && !!itemId,
    staleTime: 30 * 60000,
    retry: 1,
  });
}

/** Everything a person appears in, whoever holds it. Same gating and caching as the row above. */
export function useActorCredits(
  personId: string | null | undefined,
  enabled = true,
) {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.credits(personId ?? ""),
    queryFn: () => fetchCredits(base!, personId!, token),
    enabled: enabled && !!base && !!personId,
    staleTime: 30 * 60000,
    retry: 1,
  });
}

export function useRequestPolicy(group?: string) {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.policy(group),
    queryFn: () => fetchRequestPolicy(base!, group, token),
    enabled: !!base,
    retry: 1,
  });
}

export function useRequestUsers() {
  const { base, token } = useConnection();
  const canApprove = useCanApproveRequests();
  return useQuery({
    queryKey: keys.users,
    queryFn: () => fetchRequestUsers(base!, token),
    enabled: !!base && canApprove,
    retry: 1,
  });
}

export function useRequestNotifications(unreadOnly = false) {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.notifications(unreadOnly),
    meta: LIVE,
    queryFn: () => fetchNotifications(base!, unreadOnly, token),
    enabled: !!base,
    refetchInterval: 30000,
    retry: 1,
  });
}

export function useCreateRequest() {
  const { base, token } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRequestInput) =>
      createRequest(base!, input, token),
    onSuccess: (made) => {
      // The row that was just pressed has to say so *now*, and say which of the two things
      // happened: a node that auto-approves starts a download, a node that does not files the
      // request behind an approval, and only the answer the node sent knows which. Find annotates
      // its results from the member's own list (`dedupeSearchResults`), and that list is a round
      // trip behind this mutation — long enough for a successfully pressed button to still read
      // "Request", which reads as a press that did nothing. Seeding the created request in closes
      // that gap: `searchAction` turns the row to "Awaiting approval" for a pending one, or
      // "Already requested" once it is approved, before the refetch below has been anywhere.
      queryClient.setQueryData<MemberRequest[]>(
        keys.list(true, undefined),
        (current) => {
          if (!current) return [made];
          return current.some((request) => request.id === made.id)
            ? current
            : [made, ...current];
        },
      );
      // The whole request domain, not just the list: a new request changes the counts, and if the
      // group already had the title it changes what the search results say too.
      queryClient.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export function useDecideRequest() {
  const { base, token } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      id: string;
      decision: "approve" | "decline" | "retry";
      reason?: string;
    }) => decideRequest(base!, args.id, args.decision, args.reason, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  });
}

/**
 * Change which seasons an open request is for.
 *
 * Distinct from `useCreateRequest` on purpose: creating again on an open request *grows* its season
 * list, because a second person asking for season 4 means "and season 4", not "only season 4". An
 * edit is the other intent, so it replaces.
 */
export function useSetRequestSeasons() {
  const { base, token } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; seasons: number[] }) =>
      setRequestSeasons(base!, args.id, args.seasons, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  });
}

export function useDeleteRequest() {
  const { base, token } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteRequest(base!, id, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  });
}

export function useSaveRequestPolicy() {
  const { base, token } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policy: RequestPolicy) =>
      saveRequestPolicy(base!, policy, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  });
}

export function useSaveRequestUser() {
  const { base, token } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      userId: string;
      trusted: boolean;
      weeklyQuota: number;
    }) =>
      saveRequestUser(
        base!,
        args.userId,
        { trusted: args.trusted, weeklyQuota: args.weeklyQuota },
        token,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.users }),
  });
}

export function useMarkNotificationsRead() {
  const { base, token } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => markNotificationsRead(base!, ids, token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  });
}

export { sameUser, selectMine } from "./requestsApi";
