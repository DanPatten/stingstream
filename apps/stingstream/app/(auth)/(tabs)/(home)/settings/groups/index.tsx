import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { SharingScreen } from "@/components/stingstream/mesh/SharingScreen";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { MESH_QUERY_KEY } from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";

export default function GroupsPage() {
  // `?advanced=1` arrives from a minted invite whose link only works on this network: the fix is
  // the address field, which lives inside a collapsed disclosure on this screen. Landing here with
  // it still folded away is the same dead end with an extra step.
  const { advanced } = useLocalSearchParams<{ advanced?: string }>();
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
      <SharingScreen openAdvanced={advanced === "1"} />
    </RefreshScreen>
  );
}
