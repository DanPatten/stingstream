import { ServersPane } from "@/components/settings/panes/ServersPane";
import { SettingsPage } from "@/components/settings/SettingsPage";

export default function ServersSettingsPage() {
  return (
    // Not behind `RequiresAdmin`. The linked-servers block inside is only mounted for an
    // administrator -- queries included, so a member fires none of the elevated calls -- and what
    // is left is the server the reader runs themselves, which is theirs to decide about.
    //
    // `?advanced=1` used to arrive here, from a minted invite whose link only worked on this
    // network, and prise open a fold holding this server's addresses. Those addresses are the
    // Domains category now, and that deep link belongs to it.
    <SettingsPage categoryKey='servers'>
      <ServersPane />
    </SettingsPage>
  );
}
