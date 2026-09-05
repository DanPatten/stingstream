import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import {
  type CreateRequestInput,
  createRequest,
  decideRequest,
  deleteRequest,
  fetchNotifications,
  fetchRequest,
  fetchRequestCounts,
  fetchRequestPolicy,
  fetchRequests,
  fetchRequestUsers,
  markNotificationsRead,
  type RequestPolicy,
  type RequestState,
  saveRequestPolicy,
  saveRequestUser,
  searchRequestable,
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
  policy: (group: string | undefined) =>
    ["stingstream", "requests", "policy", group ?? null] as const,
  users: ["stingstream", "requests", "users"] as const,
  search: (term: string, kind: string | undefined) =>
    ["stingstream", "requests", "search", term, kind ?? null] as const,
  notifications: (unreadOnly: boolean) =>
    ["stingstream", "requests", "notifications", unreadOnly] as const,
};

/** The node's StingStream API root and the token, or nulls before a server is connected. */
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
    // Ten seconds, matching the node's own fulfilment pass. Polling faster would only show the
    // same row again; polling slower would leave "Downloading" on screen after it had landed.
    refetchInterval: 10000,
  });
}

export function useRequest(id: string | undefined) {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.detail(id ?? ""),
    queryFn: () => fetchRequest(base!, id!, token),
    enabled: !!base && !!id,
    refetchInterval: 10000,
  });
}

export function useRequestCounts() {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.counts,
    queryFn: () => fetchRequestCounts(base!, token),
    enabled: !!base,
    refetchInterval: 30000,
    // A badge is a nicety. One failed poll must not put an error state in the tab bar.
    retry: 1,
  });
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
  });
}

export function useRequestPolicy(group?: string) {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.policy(group),
    queryFn: () => fetchRequestPolicy(base!, group, token),
    enabled: !!base,
  });
}

export function useRequestUsers() {
  const { base, token } = useConnection();
  const canApprove = useCanApproveRequests();
  return useQuery({
    queryKey: keys.users,
    queryFn: () => fetchRequestUsers(base!, token),
    enabled: !!base && canApprove,
  });
}

export function useRequestNotifications(unreadOnly = false) {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: keys.notifications(unreadOnly),
    queryFn: () => fetchNotifications(base!, unreadOnly, token),
    enabled: !!base,
    refetchInterval: 30000,
  });
}

export function useCreateRequest() {
  const { base, token } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRequestInput) =>
      createRequest(base!, input, token),
    // The whole request domain, not just the list: a new request changes the counts, and if the
    // group already had the title it changes what the search results say too.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all }),
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
