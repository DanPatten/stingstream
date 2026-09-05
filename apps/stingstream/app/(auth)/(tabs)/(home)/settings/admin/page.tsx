import { AdminScreen } from "@/components/stingstream/admin/AdminScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function AdminPage() {
  return (
    <RequiresAdmin>
      <AdminScreen />
    </RequiresAdmin>
  );
}
