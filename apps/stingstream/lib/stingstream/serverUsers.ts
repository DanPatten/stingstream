import type {
  UserDto,
  UserPolicy,
} from "@jellyfin/sdk/lib/generated-client/models";
import { getUserApi } from "@jellyfin/sdk/lib/utils/api";
import { getNodeBaseUrl } from "@stingstream/api-client";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { clearPasswordDerivation } from "@/lib/stingstream/identityApi";
import { apiAtom } from "@/providers/JellyfinProvider";

/**
 * The accounts on this server.
 *
 * The Users screen is built out of this rather than out of the invite list, and the difference has
 * teeth. People used to be the *invite* list, so once deleting an invite meant deleting the row,
 * somebody who had already redeemed one would have quietly vanished — a person disappearing as a
 * side effect of tidying up a link. Reading the accounts instead makes the list survive that, and
 * it picks up anybody an administrator created by hand, who was never in the invite list at all.
 *
 * Dan's own sentence is what settled it: *"sharing is basically just users not groups at this
 * point."*
 */
export const SERVER_USERS_QUERY_KEY = [
  "stingstream",
  "jellyfin-users",
] as const;

/**
 * Every account on this server.
 *
 * `enabled` is for a screen that shows this beside things a non-administrator may see.
 * `GET /Users` is elevated, so asking without it buys a 403 the caller cannot act on and a red
 * line in the console, which is the same reason `useInvites` takes the flag.
 */
export function useServerUsers(enabled = true): UseQueryResult<UserDto[]> {
  const api = useAtomValue(apiAtom);
  return useQuery({
    queryKey: SERVER_USERS_QUERY_KEY,
    queryFn: async () => (await getUserApi(api!).getUsers()).data,
    enabled: !!api && enabled,
  });
}

/**
 * Everything the Users screen does to an account.
 *
 * These were inline `useMutation`s inside the old Users tab, which is why
 * nothing else could reuse them and why "change somebody's libraries" — a thing
 * `InvitesController` explicitly defers to the Users screen — had nowhere to
 * live. Invites, mesh, requests and passkeys each keep their calls in a
 * `lib/stingstream/*` module beside their query key; users were the odd one out.
 *
 * All four go through Jellyfin's own API rather than StingStream.Core: user CRUD
 * is Jellyfin's, and Core owns only playback policy and invites.
 */
const useUsersApi = () => {
  const api = useAtomValue(apiAtom);
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: SERVER_USERS_QUERY_KEY });
  return { api, invalidate };
};

/**
 * Set somebody else's password. `ResetPassword: false` means "use `NewPw`", not "clear it".
 *
 * An account that arrived from another server signs in with a value derived from its password
 * rather than the password itself, so a reset here has to say so — otherwise the client would go
 * on deriving against a salt that no longer matches anything and the person would be locked out by
 * an administrator trying to let them in. Clearing it makes the account an ordinary one, which is
 * what a reset means. A no-op for everybody else, and never fatal: the password *was* changed, and
 * failing the mutation afterwards would say otherwise.
 */
export function useSetUserPassword() {
  const { api } = useUsersApi();
  return useMutation<void, Error, { userId: string; password: string }>({
    mutationFn: async ({ userId, password }) => {
      await getUserApi(api!).updateUserPassword({
        userId,
        updateUserPassword: { ResetPassword: false, NewPw: password },
      });

      const nodeOrigin = api?.basePath ? getNodeBaseUrl(api.basePath) : null;
      if (nodeOrigin) {
        try {
          await clearPasswordDerivation(nodeOrigin, userId, api?.accessToken);
        } catch {
          // Logged nowhere and shown nowhere on purpose: the only account this can matter for is
          // one an administrator is already looking at, and the Users screen says who came from
          // where. Retrying the reset fixes it.
        }
      }
    },
  });
}

/**
 * Change your own password.
 *
 * Not `useSetUserPassword` with a different argument. That one is an administrator resetting
 * somebody else's, and it says `ResetPassword: false` with no old password because an elevated
 * caller does not need one; this one sends `CurrentPw`, because Jellyfin will not let an
 * unelevated account change its own password without proof it knows the old one.
 *
 * It also does **not** clear the linked-password derivation. That call exists so an administrator's
 * reset cannot lock out an account whose password lives on another server — but an account in that
 * state should never reach this mutation at all: the Profile pane asks
 * `fetchSignInMethod` first and offers a sentence instead of a form when the answer is "derived",
 * because the password really is set somewhere else. See `docs/INVITES.md` §11c.
 */
export function useChangeMyPassword() {
  const { api } = useUsersApi();
  return useMutation<
    void,
    Error,
    { userId: string; currentPassword: string; password: string }
  >({
    mutationFn: async ({ userId, currentPassword, password }) => {
      await getUserApi(api!).updateUserPassword({
        userId,
        updateUserPassword: { CurrentPw: currentPassword, NewPw: password },
      });
    },
  });
}

/**
 * Turn an account off or on.
 *
 * The whole policy goes back, not a patch: `updateUserPolicy` replaces it, and
 * there is no `getPolicy` to read one back from — the caller holds the `UserDto`
 * and passes the policy it already has.
 */
export function useSetUserDisabled() {
  const { api, invalidate } = useUsersApi();
  return useMutation<void, Error, { user: UserDto; disabled: boolean }>({
    mutationFn: async ({ user, disabled }) => {
      if (!user.Id || !user.Policy)
        throw new Error("This account has no policy to update.");
      await getUserApi(api!).updateUserPolicy({
        userId: user.Id,
        userPolicy: { ...user.Policy, IsDisabled: disabled },
      });
    },
    onSuccess: invalidate,
  });
}

/**
 * Write a whole policy back for one account.
 *
 * Deliberately generic: `updateUserPolicy` replaces the entire policy, so every caller has to do
 * the read-modify-write anyway, and the *rules* about what the new policy should be are pure and
 * tested in `components/stingstream/users/userAccess.ts` — `policyForSelection` for the library
 * ticks, `policyForAdminChange` for the administrator switch. This hook only posts what they
 * decided; it does not have an opinion of its own.
 */
export function useSetUserPolicy() {
  const { api, invalidate } = useUsersApi();
  return useMutation<void, Error, { userId: string; policy: UserPolicy }>({
    mutationFn: async ({ userId, policy }) => {
      await getUserApi(api!).updateUserPolicy({ userId, userPolicy: policy });
    },
    onSuccess: invalidate,
  });
}

/**
 * Delete an account, for good.
 *
 * The server revokes their tokens and removes their playlists on the way out
 * (`UserController.DeleteUser`), so this is not reversible and the caller is
 * expected to have asked first. Deleting the invite that created somebody does
 * *not* do this — that only removes the link.
 */
export function useDeleteUser() {
  const { api, invalidate } = useUsersApi();
  return useMutation<void, Error, string>({
    mutationFn: async (userId) => {
      await getUserApi(api!).deleteUser({ userId });
    },
    onSuccess: invalidate,
  });
}
