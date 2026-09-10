import { NotificationsPane } from "@/components/settings/panes/NotificationsPane";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function NotificationsSettingsPage() {
  return (
    <SettingsPage categoryKey='notifications'>
      {/* Inside the page, not around it: a member who pasted this URL still gets
          the settings they can open, with the refusal in the pane. */}
      <RequiresAdmin>
        <NotificationsPane />
      </RequiresAdmin>
    </SettingsPage>
  );
}
