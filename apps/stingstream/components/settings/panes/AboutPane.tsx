import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { space } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { AboutSection } from "../AboutSection";
import { FocusTarget } from "../FocusTarget";
import { StorageSettings } from "../StorageSettings";
import { SettingsPane } from "./SettingsPane";

/**
 * What this build is, what it is keeping on this device, and its own log.
 *
 * The app's log lives here rather than under the administrator's "Logs &
 * status", and the two are genuinely different things: this one is what *this
 * copy of the app* recorded, in memory, on this device, and every account has
 * it; that one is the server's own log files, which only an administrator can
 * read. Filing them together would put a device diagnostic behind an
 * elevation check for no reason.
 */
export const AboutPane: React.FC = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const isWeb = Platform.OS === "web";

  return (
    <SettingsPane title={t("home.settings.nav.about")}>
      <FocusTarget id='app-version'>
        <AboutSection />
      </FocusTarget>

      {/* Nothing is ever downloaded to a browser -- `expo-file-system` is a stub
          there -- so the row and its "delete all" action would both be about a
          store that does not exist. */}
      {isWeb ? null : (
        <View style={{ marginTop: space["4"] }}>
          <FocusTarget id='device-storage'>
            <StorageSettings />
          </FocusTarget>
        </View>
      )}

      <View style={{ marginTop: space["4"] }}>
        <FocusTarget id='app-logs'>
          <ListGroup title={t("home.settings.about.diagnostics_title")}>
            <ListItem
              testID='settings-app-logs'
              title={t("home.settings.logs.logs_title")}
              subtitle={t("home.settings.about.app_logs_hint")}
              showArrow
              onPress={() => router.navigate("/settings/logs" as never)}
            />
          </ListGroup>
        </FocusTarget>
      </View>
    </SettingsPane>
  );
};
