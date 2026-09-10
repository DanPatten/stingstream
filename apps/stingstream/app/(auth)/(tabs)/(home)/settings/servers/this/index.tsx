import { ThisServerPane } from "@/components/settings/panes/ThisServerPane";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

/**
 * This server's own settings, reached by pressing its row on Servers.
 *
 * A static segment beside `[group]`, which is what the linked servers use: they are addressed by
 * their group id and this one has none, being the node the app is talking to.
 */
export default function ThisServerSettingsPage() {
  return (
    <SettingsPage
      categoryKey='servers'
      invalidate={[["stingstream", "jellyfin-config"]]}
    >
      {/* Inside the page, not around it: renaming the server is elevated, and a member who
          arrives here still gets the settings column with the refusal in the pane. */}
      <RequiresAdmin>
        <ThisServerPane />
      </RequiresAdmin>
    </SettingsPage>
  );
}
