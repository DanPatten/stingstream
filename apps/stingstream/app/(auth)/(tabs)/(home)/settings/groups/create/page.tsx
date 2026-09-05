import { CreateGroupScreen } from "@/components/stingstream/mesh/CreateGroupScreen";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function CreateGroupPage() {
  // No refresh to do — the screen is a form until the group exists.
  return (
    <RefreshScreen refreshing={false} onRefresh={() => {}}>
      <RequiresAdmin>
        <CreateGroupScreen />
      </RequiresAdmin>
    </RefreshScreen>
  );
}
