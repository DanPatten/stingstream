import { Stack } from "expo-router";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import {
  commonScreenOptions,
  nestedTabPageScreenOptions,
  useStackScreenOptions,
  useTabRootScreenOptions,
} from "@/components/stacks/NestedTabPageStack";

export default function SearchLayout() {
  const { t } = useTranslation();
  const screenOptions = useStackScreenOptions();
  const tabRootOptions = useTabRootScreenOptions();
  // One options object for two routes: the group's `index` (which is
  // `/`, and which the phone's tab bar lands on) and the named route
  // that gives the section a URL of its own — `search`. See
  // `(search)/search.tsx`.
  const sectionOptions: ComponentProps<typeof Stack.Screen>["options"] = {
    headerTitle: t("tabs.search"),
    headerBlurEffect: "none",
    headerTransparent: Platform.OS === "ios",
    headerShadowVisible: false,
    ...tabRootOptions,
  };

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name='index' options={sectionOptions} />
      <Stack.Screen name='search' options={sectionOptions} />
      {Object.entries(nestedTabPageScreenOptions).map(([name, options]) => (
        <Stack.Screen key={name} name={name} options={options} />
      ))}
      <Stack.Screen
        name='collections/[collectionId]'
        options={{
          title: "",
          headerShown: !Platform.isTV,
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen name='jellyseerr/page' options={commonScreenOptions} />
      <Stack.Screen
        name='jellyseerr/person/[personId]'
        options={commonScreenOptions}
      />
      <Stack.Screen
        name='jellyseerr/company/[companyId]'
        options={commonScreenOptions}
      />
      <Stack.Screen
        name='jellyseerr/genre/[genreId]'
        options={commonScreenOptions}
      />
    </Stack>
  );
}
