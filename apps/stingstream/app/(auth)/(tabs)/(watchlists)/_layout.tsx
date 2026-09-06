import { Stack } from "expo-router";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { HeaderButton } from "@/components/common/HeaderButton";
import { HeaderIcon } from "@/components/common/HeaderIcon";
import {
  nestedTabPageScreenOptions,
  useMoreChildScreenOptions,
  useStackScreenOptions,
} from "@/components/stacks/NestedTabPageStack";
import useRouter from "@/hooks/useAppRouter";
import { useStreamystatsEnabled } from "@/hooks/useWatchlists";

// The promoted-watchlists "See all" on the home page pushes a fully qualified
// `(watchlists)` path from the home tab, which would otherwise build this tab's
// stack as just [detail] — no back button, and the tab pinned to that watchlist.
// Same reasoning as the `(libraries)` layout; see the comment there, including
// why the anchor is the named route rather than `index`.
export const unstable_settings = Platform.isTV ? {} : { anchor: "watchlists" };

export default function WatchlistsLayout() {
  const { t } = useTranslation();
  const router = useRouter();
  const streamystatsEnabled = useStreamystatsEnabled();
  const screenOptions = useStackScreenOptions();
  const moreChildOptions = useMoreChildScreenOptions();

  // One options object for two routes: the group's `index` (which is
  // `/`, and which the phone's tab bar lands on) and the named route
  // that gives the section a URL of its own — `watchlists`. See
  // `(watchlists)/watchlists.tsx`.
  const sectionOptions: ComponentProps<typeof Stack.Screen>["options"] = {
    headerTitle: t("watchlists.title"),
    headerBlurEffect: "none",
    headerTransparent: Platform.OS === "ios",
    headerShadowVisible: false,
    headerRight: streamystatsEnabled
      ? () => (
          <HeaderButton
            accessibilityLabel={t("watchlists.create_title")}
            onPress={() => router.push("/(auth)/(tabs)/(watchlists)/create")}
          >
            <HeaderIcon name='add' />
          </HeaderButton>
        )
      : undefined,
    ...moreChildOptions,
  };

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name='index' options={sectionOptions} />
      <Stack.Screen name='watchlists' options={sectionOptions} />
      <Stack.Screen
        name='[watchlistId]'
        options={{
          title: "",
          headerShown: !Platform.isTV,
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='create'
        options={{
          title: t("watchlists.create_title"),
          presentation: "modal",
          headerShown: !Platform.isTV,
          headerStyle: { backgroundColor: "#171717" },
          headerTintColor: "white",
          contentStyle: { backgroundColor: "#171717" },
        }}
      />
      <Stack.Screen
        name='edit/[watchlistId]'
        options={{
          title: t("watchlists.edit_title"),
          presentation: "modal",
          headerShown: !Platform.isTV,
          headerStyle: { backgroundColor: "#171717" },
          headerTintColor: "white",
          contentStyle: { backgroundColor: "#171717" },
        }}
      />
      {Object.entries(nestedTabPageScreenOptions).map(([name, options]) => (
        <Stack.Screen key={name} name={name} options={options} />
      ))}
    </Stack>
  );
}
