import { useTranslation } from "react-i18next";
import { QualityProfilesSection } from "@/components/stingstream/settings/QualityProfilesSection";
import { QueryState } from "@/components/stingstream/shared/ScreenState";
import { FocusTarget } from "../FocusTarget";
import { SettingsPane } from "./SettingsPane";
import { useSharedSettingsField } from "./useSharedSettingsField";

/**
 * Quality profiles, and the cutoff at which a better copy stops being fetched.
 *
 * The profiles are the server's own (`SharedSettings.QualityProfiles`), so this
 * page works the same on a node with no indexer yet, where the managers that
 * use them are not running. The sync hands them over when they start.
 */
export const QualityPane: React.FC = () => {
  const { t } = useTranslation();
  const { query, value, saving, save } = useSharedSettingsField(
    "DefaultQualityProfileName",
  );

  return (
    <SettingsPane
      title={t("home.settings.nav.quality")}
      detail={t("home.settings.nav.quality_hint")}
    >
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        onRetry={query.refetch}
      >
        {query.data ? (
          <FocusTarget id={["quality-profiles", "quality-cutoff"]}>
            <QualityProfilesSection
              value={value ?? ""}
              saving={saving}
              onSave={save}
            />
          </FocusTarget>
        ) : null}
      </QueryState>
    </SettingsPane>
  );
};
