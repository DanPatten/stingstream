import { useTranslation } from "react-i18next";
import { NotificationsSection } from "@/components/stingstream/settings/NotificationsSection";
import { QueryState } from "@/components/stingstream/shared/ScreenState";
import { FocusTarget } from "../FocusTarget";
import { SettingsPane } from "./SettingsPane";
import { useSharedSettingsField } from "./useSharedSettingsField";

/**
 * Where this server says a download finished, a grab failed, or an episode
 * landed — including any extra webhooks.
 */
export const NotificationsPane: React.FC = () => {
  const { t } = useTranslation();
  const { query, value, saving, save } =
    useSharedSettingsField("Notifications");

  return (
    <SettingsPane
      title={t("home.settings.nav.notifications")}
      scope='server'
      detail={t("home.settings.nav.notifications_hint")}
    >
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        onRetry={query.refetch}
      >
        {value ? (
          <FocusTarget id='webhooks'>
            <NotificationsSection value={value} saving={saving} onSave={save} />
          </FocusTarget>
        ) : null}
      </QueryState>
    </SettingsPane>
  );
};
