import { SharingServerScreen } from "@/components/stingstream/mesh/SharingServerScreen";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function SharingServerPage() {
  // No refresh to do — the screen is a form, and it seeds itself from the node once.
  return (
    <RefreshScreen refreshing={false} onRefresh={() => {}}>
      <RequiresAdmin>
        <SharingServerScreen />
      </RequiresAdmin>
    </RefreshScreen>
  );
}
