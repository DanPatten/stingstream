import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";
import { UsersScreen } from "@/components/stingstream/users/UsersScreen";
import { INVITES_QUERY_KEY } from "@/lib/stingstream/invites";
import { SERVER_USERS_QUERY_KEY } from "@/lib/stingstream/serverUsers";

/**
 * `/users` — a section of its own rather than a settings sub-page.
 *
 * It has one address, unlike Sharing before it, which answered to both
 * `/sharing` and `/settings/groups` and so could light two different sidebar
 * rows depending on how you arrived.
 */
export default function UsersPage() {
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const onRefresh = async () => {
    setRefreshing(true);
    // Both halves of the list: the accounts and the invitations nobody has opened.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: SERVER_USERS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: INVITES_QUERY_KEY }),
    ]);
    setRefreshing(false);
  };

  return (
    <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
      <RequiresAdmin>
        <UsersScreen />
      </RequiresAdmin>
    </RefreshScreen>
  );
}
