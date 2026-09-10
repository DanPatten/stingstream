import { useTranslation } from "react-i18next";
import { DomainsScreen } from "@/components/stingstream/domains/DomainsScreen";
import { SettingsPane } from "./SettingsPane";

/**
 * Where people reach this server.
 *
 * Badged `server` because everything on it changes the answer for everybody: the address is what
 * every invite link is built from and what passkeys are bound to, and a tunnel is a process this
 * machine runs on behalf of the whole group.
 *
 * Sits in the Servers group rather than under Server administration, because it is the same
 * subject as the page beside it — Servers is who this server is linked to, Domains is how anybody
 * gets to it. It is still administrator-only, for the ordinary reason: every call behind it needs
 * Jellyfin's elevation policy.
 */
export const DomainsPane: React.FC = () => {
  const { t } = useTranslation();

  return (
    <SettingsPane
      title={t("home.settings.nav.domains")}
      detail={t("home.settings.nav.domains_hint")}
    >
      <DomainsScreen />
    </SettingsPane>
  );
};
