import { t } from "i18next";
import { useAtom } from "jotai";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PageContainer } from "@/components/common/PageContainer";
import { Pill } from "@/components/common/Pill";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { AboutSection } from "@/components/settings/AboutSection";
import { AppLanguageSelector } from "@/components/settings/AppLanguageSelector";
import { LinkDevice } from "@/components/settings/LinkDevice";
import { PasskeysSection } from "@/components/settings/PasskeysSection";
import { ProfileHeader } from "@/components/settings/ProfileHeader";
import { StorageSettings } from "@/components/settings/StorageSettings";
import { useMeshSummary } from "@/components/stingstream/mesh/DeviceMeshSection";
import useRouter from "@/hooks/useAppRouter";
import { useJellyfin, userAtom } from "@/providers/JellyfinProvider";

// TV-specific settings component
const SettingsTV = Platform.isTV ? require("./settings.tv").default : null;

// Mobile settings component
function SettingsMobile() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [user] = useAtom(userAtom);
  const { logout } = useJellyfin();
  const meshSummary = useMeshSummary();
  const isAdmin = !!user?.Policy?.IsAdministrator;
  const isWeb = Platform.OS === "web";

  // The embedded mesh has no web build at all, so `meshSummary`'s own "Not on this platform" is
  // technically true but reads like an error. Web streams always go through the home server one
  // way or another, so say that instead of describing what is missing.
  const deviceStatus = isWeb
    ? t("home.settings.sections.this_device_web")
    : meshSummary;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior='automatic'
      contentContainerStyle={{
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      <PageContainer width='settings'>
        <View
          className='flex flex-col'
          style={{
            paddingTop: Platform.OS === "android" ? 10 : 16,
            paddingBottom: 32,
          }}
        >
          <ProfileHeader />

          <View className='mt-2 mb-4' testID='settings-section-general'>
            <View className='mb-4'>
              <AppLanguageSelector />
            </View>
            <ListGroup title={t("home.settings.sections.general")}>
              <ListItem
                onPress={() => router.push("/settings/appearance")}
                showArrow
                title={t("home.settings.appearance.title")}
              />
              <ListItem
                onPress={() => router.push("/settings/playback-controls")}
                showArrow
                title={t("home.settings.playback_controls.title")}
              />
              <ListItem
                onPress={() => router.push("/settings/audio-subtitles")}
                showArrow
                title={t("home.settings.audio_subtitles.title")}
              />
              <ListItem
                onPress={() => router.push("/settings/music")}
                showArrow
                title={t("home.settings.music.title")}
              />
              <ListItem
                onPress={() => router.push("/settings/network")}
                showArrow
                title={t("home.settings.network.title")}
              />
              <ListItem
                onPress={() => router.push("/settings/plugins")}
                showArrow
                title={t("home.settings.plugins.plugins_title")}
              />
            </ListGroup>
            {/* Downloads and app-storage usage do not exist on web — nothing here is ever
                downloaded to a browser, so the row and its "delete all" action make no sense
                there. */}
            {!isWeb && (
              <View className='mt-4'>
                <StorageSettings />
              </View>
            )}
          </View>

          <View className='mb-4' testID='settings-section-sharing'>
            <ListGroup title={t("home.settings.sections.sharing")}>
              {/* Servers, not "Sharing": what this screen lists is the other people's servers this
                  one pools libraries with. Inviting a *person* is no longer here at all — that is
                  what Users is, and it has a section of its own. */}
              <ListItem
                testID='settings-servers'
                onPress={() => router.push("/settings/servers")}
                showArrow
                title={t("home.settings.sections.servers")}
                subtitle={t("home.settings.sections.servers_hint")}
              />
              {isWeb ? (
                // The web fallback is a full sentence, not a badge — a `Pill` truncated the row's
                // own title to fit it (confirmed live at 390px) where `subtitle` just wraps under
                // it, which is what it is for.
                <ListItem
                  title={t("home.settings.sections.this_device")}
                  subtitle={deviceStatus}
                />
              ) : (
                <ListItem title={t("home.settings.sections.this_device")}>
                  <Pill label={deviceStatus} tone='neutral' />
                </ListItem>
              )}
            </ListGroup>
          </View>

          {isAdmin && (
            <View className='mb-4' testID='settings-section-server'>
              <ListGroup title={t("home.settings.sections.server")}>
                {/* First, and its own row: who can get in is the question people come here with
                    most, and it used to be a tab behind a screen about transcoding. */}
                <ListItem
                  testID='settings-users'
                  onPress={() => router.push("/users")}
                  showArrow
                  title={t("home.settings.sections.users")}
                  subtitle={t("home.settings.sections.users_hint")}
                />
                <ListItem
                  onPress={() => router.push("/settings/server")}
                  showArrow
                  title={t("home.settings.sections.server_settings")}
                  subtitle={t("home.settings.sections.server_settings_hint")}
                />
                <ListItem
                  onPress={() => router.push("/settings/admin")}
                  showArrow
                  title={t("home.settings.sections.libraries_and_transcoding")}
                  subtitle={t(
                    "home.settings.sections.libraries_and_transcoding_hint",
                  )}
                />
                <ListItem
                  onPress={() => router.push("/settings/node")}
                  showArrow
                  title={t("home.settings.sections.server_status")}
                  subtitle={t("home.settings.sections.server_status_hint")}
                />
                <ListItem
                  onPress={() => router.push("/settings/logs")}
                  showArrow
                  title={t("home.settings.logs.logs_title")}
                />
              </ListGroup>
            </View>
          )}

          <View className='mb-4' testID='settings-section-account'>
            <LinkDevice className='mb-4' />
            {/* Draws nothing unless this browser and this server can both do a passkey, so a phone
                and a server without a domain never see a section they cannot use. */}
            <PasskeysSection className='mb-4' />
            <ListGroup title={t("home.settings.sections.account")}>
              <ListItem
                testID='settings-sign-out'
                textColor='red'
                onPress={() => logout()}
                title={t("home.settings.sections.sign_out")}
              />
            </ListGroup>
          </View>

          <View testID='settings-section-about'>
            <AboutSection />
          </View>
        </View>
      </PageContainer>
    </ScrollView>
  );
}

export default function settings() {
  // Use TV settings component on TV platforms
  if (Platform.isTV && SettingsTV) {
    return <SettingsTV />;
  }

  return <SettingsMobile />;
}
