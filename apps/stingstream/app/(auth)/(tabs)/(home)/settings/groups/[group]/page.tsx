import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { GroupDetailScreen } from "@/components/stingstream/mesh/GroupDetailScreen";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { EmptyState } from "@/components/stingstream/shared/ScreenState";
import { MESH_QUERY_KEY } from "@/lib/stingstream/mesh";

export default function GroupDetailPage() {
  const { group } = useLocalSearchParams<{ group: string }>();
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const onRefresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: MESH_QUERY_KEY });
    setRefreshing(false);
  };

  return (
    <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
      {group ? (
        <GroupDetailScreen group={group} />
      ) : (
        <EmptyState
          title='No group'
          detail='That link is missing a group id.'
        />
      )}
    </RefreshScreen>
  );
}
