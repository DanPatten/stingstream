import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PageContainer } from "@/components/common/PageContainer";

/**
 * Common scaffold for every StingStream screen: safe-area padding matching
 * the rest of the app's mobile screens (see FavoritesPage, settings pages),
 * a `PageContainer` (`settings` width — 960 — so a form or a list stays
 * readable on a wide browser window instead of running the full width of the
 * monitor), plus pull-to-refresh wired to whatever refetch the screen wants
 * to run.
 */
export function RefreshScreen({
  refreshing,
  onRefresh,
  children,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      nestedScrollEnabled
      contentInsetAdjustmentBehavior='automatic'
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
      contentContainerStyle={{
        paddingLeft: insets.left,
        paddingRight: insets.right,
        paddingBottom: insets.bottom + 24,
      }}
    >
      <View style={{ paddingTop: Platform.OS === "android" ? 10 : 16 }}>
        <PageContainer width='settings'>{children}</PageContainer>
      </View>
    </ScrollView>
  );
}
