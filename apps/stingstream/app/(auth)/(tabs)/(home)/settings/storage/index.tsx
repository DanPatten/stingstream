import { StoragePane } from "@/components/settings/panes/StoragePane";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function StorageSettingsPage() {
  return (
    <SettingsPage
      categoryKey='storage'
      invalidate={[
        ["stingstream", "jellyfin-config"],
        ["stingstream", "jellyfin-libraries"],
      ]}
    >
      {/* Inside the page, not around it: a member who pasted this URL still gets
          the settings they can open, with the refusal in the pane. */}
      <RequiresAdmin>
        <StoragePane />
      </RequiresAdmin>
    </SettingsPage>
  );
}
