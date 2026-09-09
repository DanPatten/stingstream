import { useLocalSearchParams } from "expo-router";
import {
  AdminScreen,
  sectionFromParam,
} from "@/components/stingstream/admin/AdminScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

export default function AdminPage() {
  // `?section=libraries` from Home's "Add media". Unknown values fall back to Libraries rather
  // than rendering an empty screen under a segmented control.
  const { section } = useLocalSearchParams<{ section?: string }>();
  return (
    <RequiresAdmin>
      <AdminScreen initialSection={sectionFromParam(section)} />
    </RequiresAdmin>
  );
}
