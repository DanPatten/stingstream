import { useTranslation } from "react-i18next";
import {
  InviteUserButton,
  ServersScreen,
} from "@/components/stingstream/mesh/ServersScreen";
import { useIsStingStreamAdmin } from "@/components/stingstream/shared/RequiresAdmin";
import { SettingsPane } from "./SettingsPane";

/**
 * The one federation page.
 *
 * **No scope badge.** It read *Whole server* beside a title that already says
 * *Servers*, on a page that lists them. Dan: *"whole server label on Servers is
 * confusing - remove that"*. The badge is worth its width where a page could
 * plausibly be about this device or this account instead; here it could not.
 */
export const ServersPane: React.FC = () => {
  const { t } = useTranslation();
  const isAdmin = useIsStingStreamAdmin();

  return (
    <SettingsPane
      title={t("home.settings.nav.servers")}
      detail={t("home.settings.nav.servers_hint")}
      // Beside the title, because the list below no longer carries a heading of its own to hang it
      // from — two *Servers* headings down one column was the thing being fixed.
      accessory={isAdmin ? <InviteUserButton /> : null}
    >
      <ServersScreen />
    </SettingsPane>
  );
};
