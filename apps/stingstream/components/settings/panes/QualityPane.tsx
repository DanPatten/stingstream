import { useTranslation } from "react-i18next";
import { QualityProfilesSection } from "@/components/stingstream/settings/QualityProfilesSection";
import { QueryState } from "@/components/stingstream/shared/ScreenState";
import { FocusTarget } from "../FocusTarget";
import { SettingsPane } from "./SettingsPane";
import { useSharedSettingsField } from "./useSharedSettingsField";

/**
 * Quality profiles, and the cutoff at which a better copy stops being fetched.
 *
 * The section says so itself when the movie manager and the series manager
 * disagree about a profile, rather than showing one app's answer as if it were
 * both — the same instinct as the Downloads list naming an engine that did not
 * report.
 */
export const QualityPane: React.FC = () => {
  const { t } = useTranslation();
  const { query, value, saving, save } = useSharedSettingsField(
    "DefaultQualityProfileName",
  );

  return (
    <SettingsPane
      title={t("home.settings.nav.quality")}
      scope='server'
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
