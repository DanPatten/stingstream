import { PageContainer } from "@/components/common/PageContainer";
import { SharePeopleScreen } from "@/components/stingstream/accounts/SharePeopleScreen";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function SharePage() {
  // The screen refreshes itself when a share changes; there is nothing a pull would add.
  return (
    <RefreshScreen refreshing={false} onRefresh={() => {}}>
      <PageContainer width='settings'>
        <RequiresAdmin>
          <SharePeopleScreen />
        </RequiresAdmin>
      </PageContainer>
    </RefreshScreen>
  );
}
