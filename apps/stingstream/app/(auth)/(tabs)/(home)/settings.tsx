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
import {
  buildSettingsGroups,
  type SettingsRow,
} from "@/components/shell/buildSettingsSections";
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
  const isWeb = Platform.OS === "web";

  // The embedded mesh has no web build at all, so `meshSummary`'s own "Not on this platform" is
  // technically true but reads like an error. Web streams always go through the home server one
  // way or another, so say that instead of describing what is missing.
  const deviceStatus = isWeb
    ? t("home.settings.sections.this_device_web")
    : meshSummary;

  // Which rows this account gets is a rule, and it lives in one tested place —
  // `components/shell/buildSettingsSections.ts`, the way the sidebar's rows do.
  const groups = buildSettingsGroups(user, t);

  const renderRow = (row: SettingsRow) => {
    if (row.kind === "deviceStatus") {
      return isWeb ? (
        // The web fallback is a full sentence, not a badge — a `Pill` truncated the row's own
        // title to fit it (confirmed live at 390px) where `subtitle` just wraps under it, which
        // is what it is for.
        <ListItem key={row.key} title={row.label} subtitle={deviceStatus} />
      ) : (
        <ListItem key={row.key} title={row.label}>
          <Pill label={deviceStatus} tone='neutral' />
        </ListItem>
      );
    }
    return (
      <ListItem
        key={row.key}
        testID={row.testID}
        onPress={() => router.push(row.route as never)}
        showArrow
        title={row.label}
        subtitle={row.detail}
      />
    );
  };

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

          {groups.map((group) => (
            <View
              key={group.key}
              className={group.key === "general" ? "mt-2 mb-4" : "mb-4"}
              testID={group.testID}
            >
              {group.key === "general" && (
                <View className='mb-4'>
                  <AppLanguageSelector />
                </View>
              )}
              <ListGroup title={group.title}>
                {group.rows.map(renderRow)}
              </ListGroup>
              {/* Downloads and app-storage usage do not exist on web — nothing here is ever
                  downloaded to a browser, so the row and its "delete all" action make no sense
                  there. */}
              {group.key === "general" && !isWeb && (
                <View className='mt-4'>
                  <StorageSettings />
                </View>
              )}
            </View>
          ))}

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
