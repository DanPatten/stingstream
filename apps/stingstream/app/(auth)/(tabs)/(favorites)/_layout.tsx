import { Stack } from "expo-router";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import {
  nestedTabPageScreenOptions,
  useMoreChildScreenOptions,
  useStackScreenOptions,
} from "@/components/stacks/NestedTabPageStack";

export default function SearchLayout() {
  const { t } = useTranslation();
  const screenOptions = useStackScreenOptions();
  const moreChildOptions = useMoreChildScreenOptions();
  // One options object for two routes: the group's `index` (which is
  // `/`, and which the phone's tab bar lands on) and the named route
  // that gives the section a URL of its own — `favorites`. See
  // `(favorites)/favorites.tsx`.
  const sectionOptions: ComponentProps<typeof Stack.Screen>["options"] = {
    headerTitle: t("tabs.favorites"),
    headerBlurEffect: "none",
    headerTransparent: Platform.OS === "ios",
    headerShadowVisible: false,
    ...moreChildOptions,
  };

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name='index' options={sectionOptions} />
      <Stack.Screen name='favorites' options={sectionOptions} />
      {Object.entries(nestedTabPageScreenOptions).map(([name, options]) => (
        <Stack.Screen key={name} name={name} options={options} />
      ))}
    </Stack>
  );
}
