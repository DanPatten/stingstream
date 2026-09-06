import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import {
  commonScreenOptions,
  nestedTabPageScreenOptions,
  useStackScreenOptions,
} from "@/components/stacks/NestedTabPageStack";

export default function SearchLayout() {
  const { t } = useTranslation();
  const screenOptions = useStackScreenOptions();
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen
        name='index'
        options={{
          headerTitle: t("tabs.search"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
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
