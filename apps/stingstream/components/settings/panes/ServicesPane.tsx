import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { DownloadClientsSection } from "@/components/stingstream/settings/DownloadClientsSection";
import { IndexersSection } from "@/components/stingstream/settings/IndexersSection";
import { QueryState } from "@/components/stingstream/shared/ScreenState";
import { space } from "@/constants/theme";
import { FocusTarget } from "../FocusTarget";
import { SettingsPane } from "./SettingsPane";
import { useSharedSettingsField } from "./useSharedSettingsField";

/**
 * The machinery that finds things and fetches them: the indexers this server
 * searches, and the clients that do the downloading.
 *
 * Two cards rather than one generic row, because they fail independently and
 * for different reasons — an indexer that stopped answering and a torrent
 * engine that will not start are not the same problem, and the old single
 * "Server settings" page made you find out which by opening six tabs.
 *
 * Everything on this page is pushed into Radarr and Sonarr by the server, and a
 * push that fails is retried there (`SyncRetryWorker`), so there is no sync
 * button or failure card: nothing on this page is the reader's to retry.
 */
export const ServicesPane: React.FC = () => {
  const { t } = useTranslation();
  const { query, value, saving, save } =
    useSharedSettingsField("DownloadClients");

  return (
    <SettingsPane
      title={t("home.settings.nav.services")}
      detail={t("home.settings.nav.services_hint")}
    >
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        onRetry={query.refetch}
      >
        <FocusTarget id='indexers'>
          <IndexersSection />
        </FocusTarget>
        {value ? (
          <View style={{ marginTop: space["8"] }}>
            <FocusTarget id='download-clients'>
              <DownloadClientsSection
                value={value}
                saving={saving}
                onSave={save}
              />
            </FocusTarget>
          </View>
        ) : null}
      </QueryState>
    </SettingsPane>
  );
};
