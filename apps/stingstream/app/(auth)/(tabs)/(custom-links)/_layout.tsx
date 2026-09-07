import { Stack } from "expo-router";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import {
  useMoreChildScreenOptions,
  useStackScreenOptions,
} from "@/components/stacks/NestedTabPageStack";

export default function CustomMenuLayout() {
  const { t } = useTranslation();
  const screenOptions = useStackScreenOptions();
  const moreChildOptions = useMoreChildScreenOptions();
  // One options object for two routes: the group's `index` (which is
  // `/`, and which the phone's tab bar lands on) and the named route
  // that gives the section a URL of its own — `links`. See
  // `(custom-links)/links.tsx`.
  const sectionOptions: ComponentProps<typeof Stack.Screen>["options"] = {
    headerLargeTitle: true,
    headerTitle: t("tabs.custom_links"),
    headerBlurEffect: "none",
    headerTransparent: Platform.OS === "ios",
    headerShadowVisible: false,
    ...moreChildOptions,
  };

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name='index' options={sectionOptions} />
      <Stack.Screen name='links' options={sectionOptions} />
    </Stack>
  );
}
