import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { MyServerScreen } from "@/components/stingstream/identity/MyServerScreen";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { IDENTITY_QUERY_KEY } from "@/lib/stingstream/identity";

/**
 * `/settings/my-server` — deliberately **not** behind `RequiresAdmin`.
 *
 * Every other screen under Settings that mentions a server is about *this* one, and those are an
 * administrator's. This is about the server the person reading it runs, which is the one sharing
 * decision a client on somebody else's server still gets to make. Dan: *"make sure that client
 * users can still decide to share their server that they own in settings"*.
 */
export default function MyServerPage() {
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const onRefresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: IDENTITY_QUERY_KEY });
    setRefreshing(false);
  };

  return (
    <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
      <MyServerScreen />
    </RefreshScreen>
  );
}
