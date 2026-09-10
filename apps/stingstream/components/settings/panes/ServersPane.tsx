import { useTranslation } from "react-i18next";
import { ServersScreen } from "@/components/stingstream/mesh/ServersScreen";
import { SettingsPane } from "./SettingsPane";

/**
 * The one federation page.
 *
 * Badged `server` because that is what the bulk of it changes, even though the
 * last block on it — the server the reader runs — is about a different machine
 * entirely. A second badge for that block would be precise and unreadable: the
 * block carries its own heading saying whose server it is, which is the part
 * that actually needs saying.
 */
export const ServersPane: React.FC<{ openAdvanced?: boolean }> = ({
  openAdvanced = false,
}) => {
  const { t } = useTranslation();

  return (
    <SettingsPane
      title={t("home.settings.nav.servers")}
      scope='server'
      detail={t("home.settings.nav.servers_hint")}
    >
      <ServersScreen openAdvanced={openAdvanced} />
    </SettingsPane>
  );
};
