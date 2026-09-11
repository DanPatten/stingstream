import { useTranslation } from "react-i18next";
import {
  AddServerButton,
  ServersScreen,
} from "@/components/stingstream/mesh/ServersScreen";
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

  return (
    <SettingsPane
      title={t("home.settings.nav.servers")}
      detail={t("home.settings.nav.servers_hint")}
      // Beside the title, because the list below no longer carries a heading of its own to hang it
      // from — two *Servers* headings down one column was the thing being fixed.
      //
      // For every member, not only an administrator. The question it asks is one a member can
      // answer — *do you run a server?* — and the decision it leads to is still an
      // administrator's. Gating the button would leave the person it is most for, an end user with
      // a server of their own, with no way to say so.
      accessory={<AddServerButton />}
    >
      <ServersScreen />
    </SettingsPane>
  );
};
