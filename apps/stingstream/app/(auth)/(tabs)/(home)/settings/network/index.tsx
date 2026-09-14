import { NetworkPane } from "@/components/settings/panes/NetworkPane";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function NetworkSettingsPage() {
  return (
    // The default `[["stingstream"]]` covers every query on this page: the domains status and the
    // mesh sharing settings, and the network document under `["stingstream", "jellyfin-config"]`,
    // so a pull-to-refresh also re-asks the node whether the tunnel came up.
    <SettingsPage categoryKey='network'>
      {/* Inside the page, not around it: a member who pasted this URL still gets
          the settings they can open, with the refusal in the pane. */}
      <RequiresAdmin>
        <NetworkPane />
      </RequiresAdmin>
    </SettingsPage>
  );
}
