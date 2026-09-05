import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DownloadsScreen } from "@/components/stingstream/downloads/DownloadsScreen";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function StingStreamDownloadsPage() {
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const onRefresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ["stingstream"] });
    setRefreshing(false);
  };

  return (
    <RequiresAdmin>
      <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
        <DownloadsScreen />
      </RefreshScreen>
    </RequiresAdmin>
  );
}
