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
  approveLinkRequest,
  declineLinkRequest,
  fetchLinkRequests,
  fetchLinks,
  fetchMyLinkRequest,
  type LinkedIdentity,
  type LinkRequestSummary,
  type MyLinkRequest,
  removeLink,
  requestLink,
} from "./identityApi";

/**
 * React Query over the identity routes, split from `identityApi.ts` the same way
 * `invites.ts` is split from `invitesApi.ts`: the fetch half stays testable without React, and
 * this half owns the cache keys and what a mutation invalidates.
 *
 * The anonymous calls are deliberately **not** here. A challenge is single-use and an assertion is
 * a credential; neither belongs in a query cache, which is read back by anything that asks for the
 * key. Same reasoning as `useInviteLink` being a mutation rather than a query.
 */

export const IDENTITY_QUERY_KEY = ["stingstream", "identity"] as const;

const useIdentityApi = () => {
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  return {
    base: api?.basePath ? getStingStreamApiBaseUrl(api.basePath) : null,
    token: api?.accessToken ?? null,
    // Every route here needs a session, so asking before there is one can only produce a 401 —
    // and since auto-connect the server is set the moment a node-served page loads, which is how
    // a pair of red 401s ended up in the console of the login screen itself.
    authed: Boolean(api?.basePath) && Boolean(user?.Id),
    isAdmin: Boolean(user?.Policy?.IsAdministrator),
  };
};

/** What this account's own link request is doing. Every member has one to ask about. */
export function useMyLinkRequest(): UseQueryResult<MyLinkRequest> {
  const { base, token, authed } = useIdentityApi();
  return useQuery({
    queryKey: [...IDENTITY_QUERY_KEY, "my-link-request"],
    queryFn: () => fetchMyLinkRequest(base!, token),
    enabled: authed,
  });
}

/** Ask for the server you run to be linked with this one. */
export function useRequestLink() {
  const { base, token } = useIdentityApi();
  const queryClient = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: () => requestLink(base!, token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: IDENTITY_QUERY_KEY });
    },
  });
}

/** Which servers have asked to be linked. Administrator only. */
export function useLinkRequests(): UseQueryResult<LinkRequestSummary[]> {
  const { base, token, authed, isAdmin } = useIdentityApi();
  return useQuery({
    queryKey: [...IDENTITY_QUERY_KEY, "link-requests"],
    queryFn: () => fetchLinkRequests(base!, token),
    enabled: authed && isAdmin,
  });
}

/** Let one in, into a group of your choosing. */
export function useApproveLinkRequest() {
  const { base, token } = useIdentityApi();
  const queryClient = useQueryClient();
  return useMutation<
    void,
    Error,
    { issuerNodeId: string; groupId: string | null }
  >({
    mutationFn: ({ issuerNodeId, groupId }) =>
      approveLinkRequest(base!, issuerNodeId, groupId, token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: IDENTITY_QUERY_KEY });
    },
  });
}

/** Say no to one. */
export function useDeclineLinkRequest() {
  const { base, token } = useIdentityApi();
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (issuerNodeId) =>
      declineLinkRequest(base!, issuerNodeId, token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: IDENTITY_QUERY_KEY });
    },
  });
}

/** Who from elsewhere holds an account here. Administrator only. */
export function useLinkedIdentities(): UseQueryResult<LinkedIdentity[]> {
  const { base, token, authed, isAdmin } = useIdentityApi();
  return useQuery({
    queryKey: [...IDENTITY_QUERY_KEY, "links"],
    queryFn: () => fetchLinks(base!, token),
    enabled: authed && isAdmin,
  });
}

/** Stop one of them signing in. The account stays. */
export function useRemoveLinkedIdentity() {
  const { base, token } = useIdentityApi();
  const queryClient = useQueryClient();
  return useMutation<
    void,
    Error,
    { issuerNodeId: string; remoteUserId: string }
  >({
    mutationFn: ({ issuerNodeId, remoteUserId }) =>
      removeLink(base!, issuerNodeId, remoteUserId, token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: IDENTITY_QUERY_KEY });
    },
  });
}
