import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { JellyseerrSettings } from "@/components/settings/Jellyseerr";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";
import { useDismissKeyboardOnLeave } from "@/hooks/useDismissKeyboardOnLeave";

function JellyseerrPluginPage() {
  useDismissKeyboardOnLeave();
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior='automatic'
      contentContainerStyle={{
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      <View className='p-4'>
        <JellyseerrSettings />
      </View>
    </ScrollView>
  );
}

/**
 * The category column belongs on this page too.
 *
 * Without it a drill-in is a pane with no navigation beside it and no way
 * back to Plugins at all -- the settings sidebar simply is not drawn. The
 * gate goes inside the shell rather than around it, the way
 * `settings/servers/join` does it: a member who pastes this URL still gets
 * the settings that are theirs, with the refusal in the pane.
 */
export default function JellyseerrPluginRoute() {
  return (
    <SettingsShell categoryKey='plugins'>
      <RequiresAdmin>
        <JellyseerrPluginPage />
      </RequiresAdmin>
    </SettingsShell>
  );
}
