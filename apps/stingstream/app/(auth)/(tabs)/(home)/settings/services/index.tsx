import { ServicesPane } from "@/components/settings/panes/ServicesPane";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function ServicesSettingsPage() {
  return (
    <SettingsPage categoryKey='services'>
      {/* Inside the page, not around it: a member who pasted this URL still gets
          the settings they can open, with the refusal in the pane. */}
      <RequiresAdmin>
        <ServicesPane />
      </RequiresAdmin>
    </SettingsPage>
  );
}
