import { useLocalSearchParams } from "expo-router";
import { UsersPane } from "@/components/settings/panes/UsersPane";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function UsersSettingsPage() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  return (
    <SettingsPage categoryKey='users' invalidate={[["stingstream"]]}>
      {/* Inside the page, not around it: a member who pasted this URL still gets
          the settings they can open, with the refusal in the pane. */}
      <RequiresAdmin>
        <UsersPane initialSection={tab} />
      </RequiresAdmin>
    </SettingsPage>
  );
}
