import { FilesPane } from "@/components/settings/panes/FilesPane";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function FilesSettingsPage() {
  return (
    <SettingsPage categoryKey='files'>
      {/* Inside the page, not around it: a member who pasted this URL still gets
          the settings they can open, with the refusal in the pane. */}
      <RequiresAdmin>
        <FilesPane />
      </RequiresAdmin>
    </SettingsPage>
  );
}
