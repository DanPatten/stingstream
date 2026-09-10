import { useLocalSearchParams } from "expo-router";
import { DiagnosticsPane } from "@/components/settings/panes/DiagnosticsPane";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function DiagnosticsSettingsPage() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  return (
    <SettingsPage categoryKey='diagnostics'>
      {/* Inside the page, not around it: a member who pasted this URL still gets
          the settings they can open, with the refusal in the pane. */}
      <RequiresAdmin>
        <DiagnosticsPane initialSection={tab} />
      </RequiresAdmin>
    </SettingsPage>
  );
}
