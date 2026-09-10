import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Platform } from "react-native";
import { RequestsScreen } from "@/components/stingstream/requests/RequestsScreen";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import useRouter from "@/hooks/useAppRouter";

/**
 * Requests, for every member.
 *
 * No `RequiresAdmin` wrapper, unlike Transfers. Searching, asking and watching your own
 * requests need nothing but a Jellyfin account — the whole point of the feature is that somebody
 * who cannot administer the node can still ask it for something. The elevated parts (Approvals,
 * Activity, Policy) are simply absent from the section bar for everybody else.
 *
 * Two route params, both optional. `q` is the search term, written by Search's `Request "…"`
 * button; `tab` is the open section, so that button can land on Find directly — and so a reload, a
 * bookmark or a shared link comes back to the section it named. The page reads both and owns the
 * writing of `tab`, because the router belongs up here rather than in a section component.
 *
 * `setParams`, not `push`: the sections are flat halves of one screen rather than deep routes, and
 * pushing would put a back step between two halves of the same errand — the same reasoning as
 * Search's `Request "…"` button using `replace`.
 */
export default function StingStreamRequestsPage() {
  const { q, tab } = useLocalSearchParams<{ q?: string; tab?: string }>();
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();

  const selectTab = useCallback(
    (key: string) => router.setParams({ tab: key }),
    [router],
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ["stingstream"] });
    setRefreshing(false);
  };

  // The TV screen brings its own ScrollView and its own insets. Nesting it in
  // RefreshScreen would put two scrollable containers on one screen, which
  // makes the TV focus engine flicker between them (docs/conventions/tv.md),
  // and pull-to-refresh means nothing to a remote control anyway. It keeps its
  // sections in component state — a television has no address bar to match.
  if (Platform.isTV) {
    return <RequestsScreen />;
  }

  return (
    <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
      <RequestsScreen tab={tab} term={q ?? ""} onSelectTab={selectTab} />
    </RefreshScreen>
  );
}
