import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { useStackScreenOptions } from "@/components/stacks/NestedTabPageStack";

// The administrator's transfer queue, not the user's own offline downloads:
// the route group keeps its old name so no URL changes, the wording does not.
export default function DownloadsTabLayout() {
  const { t } = useTranslation();
  const screenOptions = useStackScreenOptions();
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen
        name='index'
        options={{
          headerTitle: t("tabs.transfers"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
    </Stack>
  );
}
