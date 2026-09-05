import { Stack } from "expo-router";
import { Platform } from "react-native";
import { stackScreenOptions } from "@/components/stacks/NestedTabPageStack";

export default function ManageLayout() {
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen
        name='index'
        options={{
          headerShown: !Platform.isTV,
          headerTitle: "Manage",
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
    </Stack>
  );
}
