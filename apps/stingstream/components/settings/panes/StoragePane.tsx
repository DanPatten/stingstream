import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { LibrariesSection } from "@/components/stingstream/settings/LibrariesSection";
import { space } from "@/constants/theme";
import { FocusTarget } from "../FocusTarget";
import { LibraryScanningSection } from "./LibraryScanningSection";
import { SettingsPane } from "./SettingsPane";

/**
 * What this server holds, and how often it looks at it.
 *
 * It used to ask the same question three times over two pages: root folders, a read-only list of
 * the libraries those folders were already in, and a Downloading page carrying the switches that
 * decided whether anything arrived in them at all. One list of libraries, each with a switch and a
 * folder, is the whole model now — see `LibrariesSection` — and scanning is the only part of the
 * old page that was about something else.
 */
export const StoragePane: React.FC = () => {
  const { t } = useTranslation();

  return (
    <SettingsPane
      title={t("home.settings.nav.storage")}
      detail={t("home.settings.nav.storage_hint")}
    >
      <FocusTarget id='libraries'>
        <LibrariesSection />
      </FocusTarget>

      <View style={{ marginTop: space["6"] }}>
        <FocusTarget id={["scan-delay", "scan-concurrency"]}>
          <LibraryScanningSection />
        </FocusTarget>
      </View>
    </SettingsPane>
  );
};
