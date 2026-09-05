import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Common scaffold for every StingStream screen: safe-area padding matching
 * the rest of the app's mobile screens (see FavoritesPage, settings pages)
 * plus pull-to-refresh wired to whatever refetch the screen wants to run.
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
      <View
        className='p-4 flex flex-col'
        style={{ paddingTop: Platform.OS === "android" ? 10 : 0 }}
      >
        {children}
      </View>
    </ScrollView>
  );
}
