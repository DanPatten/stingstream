import {
  getNodeBaseUrl,
  getStingStreamApiBaseUrl,
} from "@stingstream/api-client";
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
  fetchSignInMethod,
  forgetLinkRequest,
  type LinkedIdentity,
  type LinkRequestSummary,
  type LinkStartResult,
  type MyLinkRequest,
  removeLink,
  requestLink,
  type SignInMethod,
  startLinkRequest,
} from "./identityApi";
import { MESH_QUERY_KEY } from "./mesh";

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

/**
 * Keep this out of the persisted cache, but not out of memory. See `LIVE` in
 * `lib/stingstream/requests.ts` for the whole reasoning; the short of it is that these answers
 * change without anybody touching this app -- a peer goes offline, an administrator answers a
 * request, somebody leaves a link -- so a copy written to disk yesterday is a screen that opens
 * on something that is no longer true.
 *
 * Measured against a real node: the cache was still holding this server's shared-library answer
 * for a link that had been deleted seventy-five minutes earlier, and it was painted before
 * anything was asked.
 */
const LIVE = { persist: false } as const;

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
    meta: LIVE,
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

/**
 * Offer the server you run, from an assertion it has just signed for this one.
 *
 * A mutation and not a query for the reason the challenge and the assertion are not in here at
 * all: what goes in is single-use, and what comes back carries an invite code. Neither belongs in
 * a cache that anything asking for the key can read back.
 *
 * Every member, because asking is not deciding. The server approves an administrator's own offer
 * as it is made and holds everybody else's; which of those happened is the `status` that comes
 * back, never something this decides.
 */
export function useStartLinkRequest() {
  const { base, token } = useIdentityApi();
  const queryClient = useQueryClient();
  return useMutation<
    LinkStartResult,
    Error,
    { assertion: string; address?: string | null }
  >({
    mutationFn: (input) => startLinkRequest(base!, input, token),
    onSuccess: () => {
      // Both keys: an approval creates a link and mints an invite, so the mesh's own view of what
      // this server is part of is stale too.
      queryClient.invalidateQueries({ queryKey: IDENTITY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: MESH_QUERY_KEY });
    },
  });
}

/** Which servers have asked to be linked. Administrator only. */
export function useLinkRequests(): UseQueryResult<LinkRequestSummary[]> {
  const { base, token, authed, isAdmin } = useIdentityApi();
  return useQuery({
    queryKey: [...IDENTITY_QUERY_KEY, "link-requests"],
    meta: LIVE,
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
      // Approving creates the link it puts them in, so the mesh's own view is stale as well.
      queryClient.invalidateQueries({ queryKey: IDENTITY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: MESH_QUERY_KEY });
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

/**
 * Forget one, so that server can ask again.
 *
 * The way back from a decline, and the only one: a decision is sticky, so a mistake would
 * otherwise be permanent.
 */
export function useForgetLinkRequest() {
  const { base, token } = useIdentityApi();
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (issuerNodeId) => forgetLinkRequest(base!, issuerNodeId, token),
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
    meta: LIVE,
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

/**
 * Whether this account signs in with an ordinary password on this server, or with a value derived
 * from one it set somewhere else.
 *
 * The Profile pane asks before it offers to change a password, because for a linked account there
 * is nothing here to change: it signs in with `PBKDF2(password)` against a salt this server holds,
 * and the password itself belongs to the server the account came from
 * (`providers/JellyfinProvider.tsx`'s `secretToSend`, `docs/INVITES.md` §11c).
 *
 * `retry: false` on purpose. `fetchSignInMethod` throws rather than guessing when it cannot get a
 * definite answer, and three silent retries of a question whose failure mode is "offer the wrong
 * form" is three chances to look like a hang instead of one honest error.
 */
export function useMySignInMethod(): UseQueryResult<SignInMethod> {
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const nodeOrigin = api?.basePath ? getNodeBaseUrl(api.basePath) : null;

  return useQuery({
    queryKey: [...IDENTITY_QUERY_KEY, "sign-in-method", user?.Name],
    queryFn: () =>
      fetchSignInMethod(nodeOrigin as string, user?.Name as string),
    enabled: Boolean(nodeOrigin && user?.Name),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}
