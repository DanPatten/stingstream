import { useTranslation } from "react-i18next";
import { NamingSection } from "@/components/stingstream/settings/NamingSection";
import { QueryState } from "@/components/stingstream/shared/ScreenState";
import { FocusTarget } from "../FocusTarget";
import { SettingsPane } from "./SettingsPane";
import { useSharedSettingsField } from "./useSharedSettingsField";

/**
 * How a movie or an episode is named and filed once it has arrived.
 *
 * One of the six tabs the old *Server settings* row hid behind a single click,
 * and the reason that row's subtitle had to list all six. A page now, with an
 * address of its own.
 */
export const FilesPane: React.FC = () => {
  const { t } = useTranslation();
  const { query, value, saving, save } = useSharedSettingsField("Naming");

  return (
    <SettingsPane
      title={t("home.settings.nav.files")}
      detail={t("home.settings.nav.files_hint")}
    >
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        onRetry={query.refetch}
      >
        {value ? (
          <FocusTarget id={["movie-naming", "episode-naming"]}>
            <NamingSection value={value} saving={saving} onSave={save} />
          </FocusTarget>
        ) : null}
      </QueryState>
    </SettingsPane>
  );
};
