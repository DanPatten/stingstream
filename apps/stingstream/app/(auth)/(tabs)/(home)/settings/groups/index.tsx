import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { GroupsScreen } from "@/components/stingstream/mesh/GroupsScreen";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { MESH_QUERY_KEY } from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";

export default function GroupsPage() {
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();
  const mesh = useMesh();

  const onRefresh = async () => {
    setRefreshing(true);
    // Both halves: the home node's view of the groups, and this device's own membership.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: MESH_QUERY_KEY }),
      mesh.syncGroups(),
    ]);
    setRefreshing(false);
  };

  return (
    <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
      <GroupsScreen />
    </RefreshScreen>
  );
}
