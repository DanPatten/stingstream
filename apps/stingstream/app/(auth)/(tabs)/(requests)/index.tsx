import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Platform } from "react-native";
import { RequestsScreen } from "@/components/stingstream/requests/RequestsScreen";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";

/**
 * Requests, for every member.
 *
 * No `RequiresAdmin` wrapper, unlike Manage and Downloads. Searching, asking and watching your own
 * requests need nothing but a Jellyfin account — the whole point of the feature is that somebody
 * who cannot administer the node can still ask it for something. The elevated parts (Approvals,
 * Policy) are simply absent from the section bar for everybody else.
 */
export default function StingStreamRequestsPage() {
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const onRefresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ["stingstream"] });
    setRefreshing(false);
  };

  // The TV screen brings its own ScrollView and its own insets. Nesting it in
  // RefreshScreen would put two scrollable containers on one screen, which
  // makes the TV focus engine flicker between them (docs/conventions/tv.md),
  // and pull-to-refresh means nothing to a remote control anyway.
  if (Platform.isTV) {
    return <RequestsScreen />;
  }

  return (
    <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
      <RequestsScreen />
    </RefreshScreen>
  );
}
