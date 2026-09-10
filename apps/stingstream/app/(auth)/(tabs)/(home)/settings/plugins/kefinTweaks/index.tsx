import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KefinTweaksSettings } from "@/components/settings/KefinTweaks";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

function KefinTweaksPage() {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior='automatic'
      contentContainerStyle={{
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      <View className='px-4'>
        <KefinTweaksSettings />
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
export default function KefinTweaksRoute() {
  return (
    <SettingsShell categoryKey='plugins'>
      <RequiresAdmin>
        <KefinTweaksPage />
      </RequiresAdmin>
    </SettingsShell>
  );
}
