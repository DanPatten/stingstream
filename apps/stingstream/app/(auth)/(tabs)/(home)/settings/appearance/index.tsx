import { InterfacePane } from "@/components/settings/panes/InterfacePane";
import { SettingsPage } from "@/components/settings/SettingsPage";

export default function InterfaceSettingsPage() {
  return (
    <SettingsPage categoryKey='appearance'>
      <InterfacePane />
    </SettingsPage>
  );
}
