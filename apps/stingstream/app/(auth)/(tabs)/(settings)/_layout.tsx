import { Stack } from "expo-router";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import {
  useStackScreenOptions,
  useTabRootScreenOptions,
} from "@/components/stacks/NestedTabPageStack";

export default function SettingsLayout() {
  const { t } = useTranslation();
  const screenOptions = useStackScreenOptions();
  const tabRootOptions = useTabRootScreenOptions();

  // One options object for two routes: the group's `index` (which is
  // `/`, and which the phone's tab bar lands on) and the named route
  // that gives the section a URL of its own — `more`. See
  // `(settings)/more.tsx`.
  const sectionOptions: ComponentProps<typeof Stack.Screen>["options"] = {
    // "More" on a phone, "Settings" on a television — the same split the
    // screen itself makes; see `index.tsx`.
    headerTitle: Platform.isTV ? t("tabs.settings") : t("tabs.more"),
    headerBlurEffect: "none",
    headerTransparent: Platform.OS === "ios",
    headerShadowVisible: false,
    ...tabRootOptions,
  };

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name='index' options={sectionOptions} />
      <Stack.Screen name='more' options={sectionOptions} />
    </Stack>
  );
}
