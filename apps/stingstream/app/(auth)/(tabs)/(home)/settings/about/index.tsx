import { AboutPane } from "@/components/settings/panes/AboutPane";
import { SettingsPage } from "@/components/settings/SettingsPage";

export default function AboutSettingsPage() {
  return (
    <SettingsPage categoryKey='about'>
      <AboutPane />
    </SettingsPage>
  );
}
