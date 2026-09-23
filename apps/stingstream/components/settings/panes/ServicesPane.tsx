import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { DownloadClientsSection } from "@/components/stingstream/settings/DownloadClientsSection";
import { IndexersSection } from "@/components/stingstream/settings/IndexersSection";
import { space } from "@/constants/theme";
import { FocusTarget } from "../FocusTarget";
import { SettingsPane } from "./SettingsPane";

/**
 * The machinery that finds things and fetches them: the indexers this server
 * searches, and the download clients it sends what it finds to.
 *
 * Two cards rather than one generic row, because they fail independently and
 * for different reasons — an indexer that stopped answering and a download
 * client that refuses its password are not the same problem, and the old single
 * "Server settings" page made you find out which by opening six tabs.
 *
 * Each card loads its own list, so neither waits on the whole settings document.
 * Everything on this page is pushed into Radarr and Sonarr by the server, and a
 * push that fails is retried there (`SyncRetryWorker`), so there is no sync
 * button or failure card: nothing on this page is the reader's to retry.
 */
export const ServicesPane: React.FC = () => {
  const { t } = useTranslation();

  return (
    <SettingsPane
      title={t("home.settings.nav.services")}
      detail={t("home.settings.nav.services_hint")}
    >
      <FocusTarget id='indexers'>
        <IndexersSection />
      </FocusTarget>
      <View style={{ marginTop: space["8"] }}>
        <FocusTarget id='download-clients'>
          <DownloadClientsSection />
        </FocusTarget>
      </View>
    </SettingsPane>
  );
};
