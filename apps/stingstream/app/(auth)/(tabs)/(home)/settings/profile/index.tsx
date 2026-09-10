import { ProfilePane } from "@/components/settings/panes/ProfilePane";
import { SettingsPage } from "@/components/settings/SettingsPage";

export default function ProfileSettingsPage() {
  return (
    <SettingsPage
      categoryKey='profile'
      invalidate={[["stingstream", "identity"]]}
    >
      <ProfilePane />
    </SettingsPage>
  );
}
