import { useLocalSearchParams } from "expo-router";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { LibraryDetailScreen } from "@/components/stingstream/settings/LibraryDetailScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

/** One library's own page, opened from Settings → Libraries or a library's "..." menu. */
export default function LibrarySettingsPage() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return (
    <SettingsPage
      categoryKey='storage'
      invalidate={[["stingstream", "libraries"]]}
    >
      <RequiresAdmin>
        <LibraryDetailScreen id={id ?? ""} />
      </RequiresAdmin>
    </SettingsPage>
  );
}
