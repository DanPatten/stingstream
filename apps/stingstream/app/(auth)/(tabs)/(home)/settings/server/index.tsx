import { ServerSettingsScreen } from "@/components/stingstream/settings/ServerSettingsScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function ServerSettingsPage() {
  return (
    <RequiresAdmin>
      <ServerSettingsScreen />
    </RequiresAdmin>
  );
}
