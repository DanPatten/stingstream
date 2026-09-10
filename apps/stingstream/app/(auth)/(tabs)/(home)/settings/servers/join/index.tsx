import { SettingsShell } from "@/components/settings/SettingsShell";
import { JoinGroupScreen } from "@/components/stingstream/mesh/JoinGroupScreen";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function JoinGroupPage() {
  return (
    <SettingsShell categoryKey='servers'>
      <RefreshScreen refreshing={false} onRefresh={() => {}}>
        <RequiresAdmin>
          <JoinGroupScreen />
        </RequiresAdmin>
      </RefreshScreen>
    </SettingsShell>
  );
}
