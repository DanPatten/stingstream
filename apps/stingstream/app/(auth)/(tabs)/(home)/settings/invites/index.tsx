import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { InvitesScreen } from "@/components/stingstream/invites/InvitesScreen";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";
import { INVITES_QUERY_KEY } from "@/lib/stingstream/invites";

export default function InvitesPage() {
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const onRefresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: INVITES_QUERY_KEY });
    setRefreshing(false);
  };

  return (
    <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
      <RequiresAdmin>
        <InvitesScreen />
      </RequiresAdmin>
    </RefreshScreen>
  );
}
