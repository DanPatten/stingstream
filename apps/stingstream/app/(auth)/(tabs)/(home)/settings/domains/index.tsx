import { DomainsPane } from "@/components/settings/panes/DomainsPane";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function DomainsSettingsPage() {
  return (
    // The default `[["stingstream"]]` covers both queries on this page: the mesh sharing settings
    // the address field reads and the domains status above it are both under that key, so a
    // pull-to-refresh re-asks the node whether the tunnel came up.
    <SettingsPage categoryKey='domains'>
      {/* Inside the page, not around it: a member who pasted this URL still gets
          the settings they can open, with the refusal in the pane. */}
      <RequiresAdmin>
        <DomainsPane />
      </RequiresAdmin>
    </SettingsPage>
  );
}
