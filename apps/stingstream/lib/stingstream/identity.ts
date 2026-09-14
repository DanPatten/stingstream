import { getNodeBaseUrl, getStingStreamApiBaseUrl } from "@stingstream/api-client";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import {
  fetchLinks,
  fetchSignInMethod,
  type LinkedIdentity,
  removeLink,
  type SignInMethod,
} from "./identityApi";

/**
 * React Query over the identity routes, split from `identityApi.ts` the same way
 * `invites.ts` is split from `invitesApi.ts`: the fetch half stays testable without React, and
 * this half owns the cache keys and what a mutation invalidates.
 *
 * The anonymous calls are deliberately **not** here. A challenge is single-use and an assertion is
 * a credential; neither belongs in a query cache, which is read back by anything that asks for the
 * key. Same reasoning as `useInviteLink` being a mutation rather than a query.
 *
 * Connecting servers is not here either: that is `connections.ts`.
 */

export const IDENTITY_QUERY_KEY = ["stingstream", "identity"] as const;

/**
 * Keep this out of the persisted cache, but not out of memory. See `LIVE` in
 * `lib/stingstream/requests.ts` for the whole reasoning; the short of it is that these answers
 * change without anybody touching this app, so a copy written to disk yesterday is a screen that
 * opens on something that is no longer true.
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
