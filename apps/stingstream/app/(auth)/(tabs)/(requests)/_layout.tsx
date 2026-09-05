import { Stack } from "expo-router";
import { Platform } from "react-native";
import { stackScreenOptions } from "@/components/stacks/NestedTabPageStack";

export default function RequestsTabLayout() {
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen
        name='index'
        options={{
          headerShown: !Platform.isTV,
          headerTitle: "Requests",
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
    </Stack>
  );
}
