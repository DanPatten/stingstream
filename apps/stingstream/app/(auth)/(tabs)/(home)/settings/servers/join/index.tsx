import { SettingsShell } from "@/components/settings/SettingsShell";
import { JoinGroupScreen } from "@/components/stingstream/mesh/JoinGroupScreen";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";

// Not behind `RequiresAdmin`, and that is not a relaxation. Accepting is still elevated, on the
// server and in the screen; what changed is that somebody is now *sent* here by a link, and a
// member who follows one is a person doing the right thing rather than a person poking at a page
// they should not see. `JoinGroupScreen` answers them with the link to forward instead of a
// refusal, which needs the code, which only it has.
export default function JoinGroupPage() {
  return (
    <SettingsShell categoryKey='servers'>
      <RefreshScreen refreshing={false} onRefresh={() => {}}>
        <JoinGroupScreen />
      </RefreshScreen>
    </SettingsShell>
  );
}
