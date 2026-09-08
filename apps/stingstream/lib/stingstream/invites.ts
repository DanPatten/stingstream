import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import {
  fetchInviteLibraries,
  fetchInvites,
  type InviteLibrary,
  type InviteSummary,
  type MintedInvite,
  mintInvite,
  revokeInvite,
} from "./invitesApi";

/**
 * The administrator's half of person invites, as React Query.
 *
 * The anonymous half — looking a token up and redeeming it — is deliberately **not** here: it is
 * called from `/join` by somebody with no session at all, so it goes through plain `fetch` in
 * `invitesApi.ts` and never touches `apiAtom`, which would be null for exactly the caller that
 * needs it. Same split, and same reason, as `setup.ts` against `mesh.ts`.
 */

const useInvitesApi = () => {
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const base = api?.basePath ? getStingStreamApiBaseUrl(api.basePath) : null;
  const token = api?.accessToken ?? null;

  // Every route here is `RequiresElevation`, so asking before there is a session can only produce
  // a 401 -- and since auto-connect sets the server the moment a node-served page loads, that
  // would put a red 401 in the console of the login screen itself.
  return { base, token, authed: !!base && !!user?.Id };
};

export const INVITES_QUERY_KEY = ["stingstream", "invites"] as const;

/** Every invite this server has minted, newest first. */
export function useInvites(): UseQueryResult<InviteSummary[]> {
  const { base, token, authed } = useInvitesApi();
  return useQuery({
    queryKey: [...INVITES_QUERY_KEY, "list", base],
    queryFn: () => fetchInvites(base!, token),
    enabled: authed,
    // An invite's *status* changes without anybody on this screen doing anything — somebody
    // redeems one, or it simply runs out — so the list goes stale on its own.
    refetchInterval: 60_000,
  });
}

/** Every library on this server, for the picker. */
export function useInviteLibraries(): UseQueryResult<InviteLibrary[]> {
  const { base, token, authed } = useInvitesApi();
  return useQuery({
    queryKey: [...INVITES_QUERY_KEY, "libraries", base],
    queryFn: () => fetchInviteLibraries(base!, token),
    enabled: authed,
    // Libraries are added about once a year. Refetched when the mint dialog opens, not on a timer.
    staleTime: 5 * 60_000,
  });
}

/**
 * Mint one.
 *
 * The token in the answer is the only copy that will ever exist — the server stores a hash — so
 * the caller must show it before it navigates away. The list is invalidated so the new invite
 * appears, but the token is deliberately *not* written into the cache: a query cache is read back
 * by anything that asks for the key, and a credential does not belong in one.
 */
export function useMintInvite() {
  const { base, token } = useInvitesApi();
  const queryClient = useQueryClient();
  return useMutation<
    MintedInvite,
    Error,
    { label?: string; libraries: string[]; expiresInDays?: number }
  >({
    mutationFn: (input) => mintInvite(base!, input, token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INVITES_QUERY_KEY });
    },
  });
}

/** Withdraw one. Addressed by id, never by token. */
export function useRevokeInvite() {
  const { base, token } = useInvitesApi();
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => revokeInvite(base!, id, token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INVITES_QUERY_KEY });
    },
  });
}
