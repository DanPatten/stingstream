import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import { getUserApi } from "@jellyfin/sdk/lib/utils/api";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { apiAtom } from "@/providers/JellyfinProvider";

/**
 * The accounts on this server.
 *
 * One query, two screens. **Users & libraries** has always managed them; **Sharing** now lists them
 * as well, because Dan's own sentence settled what that screen's People half is:
 *
 * > *"sharing is basically just users not groups at this point."*
 *
 * That mattered rather than being a wording change. People used to be the *invite* list, so once
 * deleting an invite meant deleting the row (Part 9), somebody who had already redeemed one would
 * have quietly vanished from Sharing — a person disappearing as a side effect of tidying up a link.
 * Reading the accounts instead makes the list survive that, and it also picks up anybody an
 * administrator created by hand, who was never in it at all.
 *
 * The key is shared with `UsersSection` deliberately: two components asking the same question of
 * the same server should not be able to disagree about the answer, and one of them creates and
 * deletes the rows the other is showing.
 */
export const SERVER_USERS_QUERY_KEY = [
  "stingstream",
  "jellyfin-users",
] as const;

/**
 * Every account on this server.
 *
 * `enabled` is for a screen that shows this beside things a non-administrator may see — Sharing
 * does. `GET /Users` is elevated, so asking without it buys a 403 the caller cannot act on and a
 * red line in the console, which is the same reason `useInvites` takes the flag.
 */
export function useServerUsers(enabled = true): UseQueryResult<UserDto[]> {
  const api = useAtomValue(apiAtom);
  return useQuery({
    queryKey: SERVER_USERS_QUERY_KEY,
    queryFn: async () => (await getUserApi(api!).getUsers()).data,
    enabled: !!api && enabled,
  });
}
