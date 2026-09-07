import { Stack } from "expo-router";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import {
  useMoreChildScreenOptions,
  useStackScreenOptions,
} from "@/components/stacks/NestedTabPageStack";

// The administrator's transfer queue, not the user's own offline downloads:
// the route group keeps its old name so no URL changes, the wording does not.
export default function DownloadsTabLayout() {
  const { t } = useTranslation();
  const screenOptions = useStackScreenOptions();
  const moreChildOptions = useMoreChildScreenOptions();
  // One options object for two routes: the group's `index` (which is
  // `/`, and which the phone's tab bar lands on) and the named route
  // that gives the section a URL of its own — `transfers`. See
  // `(downloads)/transfers.tsx`.
  const sectionOptions: ComponentProps<typeof Stack.Screen>["options"] = {
    headerTitle: t("tabs.transfers"),
    headerBlurEffect: "none",
    headerTransparent: Platform.OS === "ios",
    headerShadowVisible: false,
    ...moreChildOptions,
  };

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name='index' options={sectionOptions} />
      <Stack.Screen name='transfers' options={sectionOptions} />
    </Stack>
  );
}
