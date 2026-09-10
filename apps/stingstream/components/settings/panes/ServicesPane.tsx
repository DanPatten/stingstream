import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { DownloadClientsSection } from "@/components/stingstream/settings/DownloadClientsSection";
import { IndexersSection } from "@/components/stingstream/settings/IndexersSection";
import { SyncStatusBanner } from "@/components/stingstream/settings/SyncStatusBanner";
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
 * `SyncStatusBanner` sits above both: everything on this page is pushed into
 * Radarr and Sonarr, and a page that edited settings without saying whether
 * they had reached the two apps would be describing an intention rather than a
 * state.
 */
export const ServicesPane: React.FC = () => {
  const { t } = useTranslation();
  const { query, value, saving, save } =
    useSharedSettingsField("DownloadClients");

  return (
    <SettingsPane
      title={t("home.settings.nav.services")}
      scope='server'
      detail={t("home.settings.nav.services_hint")}
    >
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        onRetry={query.refetch}
      >
        <FocusTarget id='arr-sync'>
          <SyncStatusBanner />
        </FocusTarget>
        <View style={{ marginTop: space["4"] }}>
          <FocusTarget id='indexers'>
            <IndexersSection />
          </FocusTarget>
        </View>
        {value ? (
          <View style={{ marginTop: space["6"] }}>
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
