import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { LibrariesSection } from "@/components/stingstream/admin/LibrariesSection";
import { RootFoldersSection } from "@/components/stingstream/settings/RootFoldersSection";
import { QueryState } from "@/components/stingstream/shared/ScreenState";
import { space } from "@/constants/theme";
import { FocusTarget } from "../FocusTarget";
import { LibraryScanningSection } from "./LibraryScanningSection";
import { SettingsPane } from "./SettingsPane";
import { useSharedSettingsField } from "./useSharedSettingsField";

/**
 * Where files land, which folders Jellyfin reads as libraries, and how often it
 * looks.
 *
 * The two halves used to be a settings tab each, on two different pages, and
 * they are the same question asked twice: root folders are where Radarr and
 * Sonarr *put* things, libraries are where Jellyfin *finds* them, and a root
 * folder outside every library is a download nobody can watch.
 */
export const StoragePane: React.FC = () => {
  const { t } = useTranslation();
  const { query, value, saving, save } = useSharedSettingsField("RootFolders");

  return (
    <SettingsPane
      title={t("home.settings.nav.storage")}
      scope='server'
      detail={t("home.settings.nav.storage_hint")}
    >
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        onRetry={query.refetch}
      >
        {value ? (
          <FocusTarget id='root-folders'>
            <RootFoldersSection value={value} saving={saving} onSave={save} />
          </FocusTarget>
        ) : null}
      </QueryState>

      <View style={{ marginTop: space["6"] }}>
        <FocusTarget id='libraries'>
          <LibrariesSection />
        </FocusTarget>
      </View>

      <View style={{ marginTop: space["6"] }}>
        <FocusTarget id={["scan-delay", "scan-concurrency"]}>
          <LibraryScanningSection />
        </FocusTarget>
      </View>
    </SettingsPane>
  );
};
