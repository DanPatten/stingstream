import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Platform, ScrollView, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { FocusTarget } from "@/components/settings/FocusTarget";
import { PluginSettings } from "@/components/settings/PluginSettings";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { adminOnly } from "@/components/stingstream/shared/RequiresAdmin";
import { useSettings } from "@/utils/atoms/settings";

function PluginsPage() {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { refreshStreamyfinPluginSettings } = useSettings();

  const handleRefreshFromServer = useCallback(async () => {
    // Returns undefined when the API call fails (handled internally).
    // `force` because this is the one deliberate ask: the probe is otherwise
    // cached per server (F-23), and an admin who has just installed the plugin
    // would be told "no plugin" by a cache from before they did.
    const refreshed = await refreshStreamyfinPluginSettings({ force: true });
    if (refreshed) {
      toast.success(t("home.settings.plugins.streamystats.toasts.refreshed"));
    } else {
      toast.error(
        t("home.settings.plugins.streamystats.toasts.refresh_failed"),
      );
    }
  }, [refreshStreamyfinPluginSettings, t]);

  return (
    <SettingsShell categoryKey='plugins'>
      <ScrollView
        contentInsetAdjustmentBehavior='automatic'
        contentContainerStyle={{
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
      >
        <View
          className='px-4 flex flex-col'
          style={{ paddingTop: Platform.OS === "android" ? 10 : 0 }}
        >
          <FocusTarget id='streamystats'>
            <PluginSettings />
          </FocusTarget>

          {/* Pulls the centralised Streamyfin plugin settings for every plugin,
            so it lives on the plugins index rather than inside Streamystats. */}
          <TouchableOpacity
            onPress={handleRefreshFromServer}
            className='py-3 rounded-xl bg-neutral-800'
          >
            <Text className='text-center text-blue-500'>
              {t("home.settings.plugins.streamystats.refresh_from_server")}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SettingsShell>
  );
}

export default adminOnly(PluginsPage);
