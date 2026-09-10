import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { DownloadingSection } from "@/components/stingstream/settings/DownloadingSection";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";

/**
 * Whether this server fetches things it does not have yet.
 *
 * Three switches and nothing else. It was a section on top of `/settings/library`
 * until that page grew a Movies/TV shows tab bar: the bar scoped the whole page
 * while the switches above it governed both tabs, so a reader arriving from the
 * Requests notice met a screen that looked like two screens. The switches decide
 * what the server *runs*; the library is a list of titles it manages. Two
 * subjects, two pages.
 *
 * Administrator-only twice over, same as the library page: the row in Settings is
 * hidden without elevation, and `RequiresAdmin` is the actual control, because a
 * URL can be pasted.
 */
export default function DownloadingPage() {
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const onRefresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ["stingstream"] });
    setRefreshing(false);
  };

  return (
    <SettingsShell categoryKey='downloading'>
      <RequiresAdmin>
        <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
          <DownloadingSection />
        </RefreshScreen>
      </RequiresAdmin>
    </SettingsShell>
  );
}
