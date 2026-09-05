import { Stack } from "expo-router";
import { Platform } from "react-native";
import { stackScreenOptions } from "@/components/stacks/NestedTabPageStack";

export default function DownloadsTabLayout() {
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen
        name='index'
        options={{
          headerShown: !Platform.isTV,
          headerTitle: "Downloads",
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
    </Stack>
  );
}
