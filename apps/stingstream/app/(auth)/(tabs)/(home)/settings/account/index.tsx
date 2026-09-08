import { AccountScreen } from "@/components/stingstream/accounts/AccountScreen";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function AccountPage() {
  // No refresh to do — the screen is a form, and it reads the node's account once.
  return (
    <RefreshScreen refreshing={false} onRefresh={() => {}}>
      <RequiresAdmin>
        <AccountScreen />
      </RequiresAdmin>
    </RefreshScreen>
  );
}
