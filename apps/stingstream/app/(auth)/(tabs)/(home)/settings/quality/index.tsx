import { QualityPane } from "@/components/settings/panes/QualityPane";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function QualitySettingsPage() {
  return (
    <SettingsPage categoryKey='quality'>
      {/* Inside the page, not around it: a member who pasted this URL still gets
          the settings they can open, with the refusal in the pane. */}
      <RequiresAdmin>
        <QualityPane />
      </RequiresAdmin>
    </SettingsPage>
  );
}
