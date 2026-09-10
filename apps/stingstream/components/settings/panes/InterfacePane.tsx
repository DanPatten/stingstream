import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { space } from "@/constants/theme";
import { AppearanceSettings } from "../AppearanceSettings";
import { AppLanguageSelector } from "../AppLanguageSelector";
import { FocusTarget } from "../FocusTarget";
import { SettingsPane } from "./SettingsPane";

/**
 * How the app looks and reads, on this device.
 *
 * The language selector used to float above the whole settings list, outside
 * every group, because it belonged to none of them. It belongs here: picking
 * English or German is the same kind of decision as picking an accent color,
 * and both are stored in this install's MMKV and follow nobody anywhere.
 */
export const InterfacePane: React.FC = () => {
  const { t } = useTranslation();

  return (
    <SettingsPane
      title={t("home.settings.nav.appearance")}
      detail={t("home.settings.nav.appearance_hint")}
    >
      <FocusTarget id='app-language'>
        <AppLanguageSelector />
      </FocusTarget>
      <View style={{ marginTop: space["4"] }}>
        <FocusTarget id={["theme", "home-layout", "hidden-libraries"]}>
          <AppearanceSettings />
        </FocusTarget>
      </View>
    </SettingsPane>
  );
};
