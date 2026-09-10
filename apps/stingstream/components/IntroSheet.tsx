import { Feather, Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Platform, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/Button";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import {
  SheetBackdrop,
  type SheetBackdropProps,
  SheetModal,
  type SheetModalRef,
  SheetScrollView,
} from "@/components/common/Sheet";
import { Text } from "@/components/common/Text";
import useRouter from "@/hooks/useAppRouter";
import { useSettings } from "@/utils/atoms/settings";
import { storage } from "@/utils/mmkv";

export interface IntroSheetRef {
  present: () => void;
  dismiss: () => void;
}

export const IntroSheet = forwardRef<IntroSheetRef>((_, ref) => {
  const bottomSheetRef = useRef<SheetModalRef>(null);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { settings, updateSettings, pluginSettings } = useSettings();
  // An admin-locked toggle cannot take the write: updateSettings drops it and
  // the read stays pinned, so the row would look broken rather than locked.
  const sentryLocked = pluginSettings?.sentryEnabled?.locked === true;

  useImperativeHandle(ref, () => ({
    present: () => {
      storage.set("hasShownIntro", true);
      bottomSheetRef.current?.present();
    },
    dismiss: () => {
      bottomSheetRef.current?.dismiss();
    },
  }));

  const renderBackdrop = useCallback(
    (props: SheetBackdropProps) => (
      <SheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  const handleDismiss = useCallback(() => {
    bottomSheetRef.current?.dismiss();
  }, []);

  const handleGoToSettings = useCallback(() => {
    bottomSheetRef.current?.dismiss();
    router.push("/settings");
  }, []);

  return (
    <SheetModal
      ref={bottomSheetRef}
      enableDynamicSizing
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: "#171717" }}
      handleIndicatorStyle={{ backgroundColor: "#737373" }}
    >
      <SheetScrollView
        style={{
          paddingLeft: Math.max(16, insets.left),
          paddingRight: Math.max(16, insets.right),
        }}
      >
        <View className={Platform.isTV ? "py-5 space-y-4" : "py-4 space-y-6"}>
          <View>
            <Text className='text-3xl font-bold text-center mb-2'>
              {t("home.intro.welcome_to_streamyfin")}
            </Text>
            <Text className='text-center'>
              {t("home.intro.a_free_and_open_source_client_for_jellyfin")}
            </Text>
          </View>

          <View>
            <Text className='text-lg font-bold'>
              {t("home.intro.features_title")}
            </Text>
            <Text className='text-xs'>
              {t("home.intro.features_description")}
            </Text>
            <View className='flex flex-row items-center mt-4'>
              <Image
                source={require("@/assets/icons/seerr-logo.svg")}
                style={{
                  width: 50,
                  height: 50,
                }}
              />
              <View className='shrink ml-2'>
                <Text className='font-bold mb-1'>Seerr</Text>
                <Text className='shrink text-xs'>
                  {t("home.intro.jellyseerr_feature_description")}
                </Text>
              </View>
            </View>
            {!Platform.isTV && (
              <>
                <View className='flex flex-row items-center mt-4'>
                  <View
                    style={{
                      width: 50,
                      height: 50,
                    }}
                    className='flex items-center justify-center'
                  >
                    <Ionicons
                      name='cloud-download-outline'
                      size={32}
                      color='white'
                    />
                  </View>
                  <View className='shrink ml-2'>
                    <Text className='font-bold mb-1'>
                      {t("home.intro.downloads_feature_title")}
                    </Text>
                    <Text className='shrink text-xs'>
                      {t("home.intro.downloads_feature_description")}
                    </Text>
                  </View>
                </View>
                <View className='flex flex-row items-center mt-4'>
                  <View
                    style={{
                      width: 50,
                      height: 50,
                    }}
                    className='flex items-center justify-center'
                  >
                    <Feather name='cast' size={28} color={"white"} />
                  </View>
                  <View className='shrink ml-2'>
                    <Text className='font-bold mb-1'>Chromecast</Text>
                    <Text className='shrink text-xs'>
                      {t("home.intro.chromecast_feature_description")}
                    </Text>
                  </View>
                </View>
              </>
            )}
            <View className='flex flex-row items-center mt-4'>
              <View
                style={{
                  width: 50,
                  height: 50,
                }}
                className='flex items-center justify-center'
              >
                <Feather name='settings' size={28} color={"white"} />
              </View>
              <View className='shrink ml-2'>
                <Text className='font-bold mb-1'>
                  {t("home.intro.centralised_settings_plugin_title")}
                </Text>
                <View className='flex-row flex-wrap items-baseline'>
                  <Text className='shrink text-xs'>
                    {t(
                      "home.intro.centralised_settings_plugin_description",
                    )}{" "}
                  </Text>
                  <TouchableOpacity
                    onPress={() => {
                      Linking.openURL(
                        "https://github.com/streamyfin/jellyfin-plugin-streamyfin",
                      );
                    }}
                  >
                    <Text tone='accent' className='text-xs underline'>
                      {t("home.intro.read_more")}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </View>

          <View>
            <Text className='text-lg font-bold'>
              {t("home.intro.crash_reports_title")}
            </Text>
            {/* The whole row toggles: the Switch itself isn't focusable on TV,
                so the TouchableOpacity carries the remote-select press there. */}
            <TouchableOpacity
              activeOpacity={0.7}
              disabled={sentryLocked}
              onPress={() =>
                updateSettings({ sentryEnabled: !settings?.sentryEnabled })
              }
              className='flex flex-row items-center mt-2'
            >
              <View
                style={{
                  width: 50,
                  height: 50,
                }}
                className='flex items-center justify-center'
              >
                <Ionicons name='bug-outline' size={28} color='white' />
              </View>
              <View className='shrink flex-1 ml-2 mr-3'>
                <Text className='shrink text-xs'>
                  {t("home.intro.crash_reports_description")}
                </Text>
              </View>
              {/* Presentational only — the row press above is the single
                  mutation path. The inertness has to come from a wrapping
                  View: a Switch ignores its own pointerEvents on Android, so
                  its native touch handler flipped it and the controlled value
                  snapped it straight back — a toggle that couldn't be
                  disabled by tapping the one control that looks tappable. */}
              <View pointerEvents='none'>
                <SettingSwitch
                  value={settings?.sentryEnabled === true}
                  disabled={sentryLocked}
                />
              </View>
            </TouchableOpacity>
            {sentryLocked && (
              <Text tone='danger' className='text-xs mt-1'>
                {t("home.settings.disabled_by_admin")}
              </Text>
            )}
          </View>

          <View>
            <Button onPress={handleDismiss} className='mt-4'>
              {t("home.intro.done_button")}
            </Button>
            <TouchableOpacity onPress={handleGoToSettings} className='mt-4'>
              <Text tone='accent' className='text-center'>
                {t("home.intro.go_to_settings_button")}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={{ height: insets.bottom }} />
        </View>
      </SheetScrollView>
    </SheetModal>
  );
});

IntroSheet.displayName = "IntroSheet";
