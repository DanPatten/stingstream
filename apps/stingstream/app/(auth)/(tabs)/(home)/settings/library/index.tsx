import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { FocusTarget } from "@/components/settings/FocusTarget";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { LibrarySection } from "@/components/stingstream/arr/LibrarySection";
import { DownloadingSection } from "@/components/stingstream/settings/DownloadingSection";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";
import { SegmentedControlBar } from "@/components/stingstream/shared/SegmentedControl";

/**
 * The movie and series managers' library — add, retune, remove.
 *
 * This was the Movies and Series halves of the Manage tab. It is a settings
 * screen rather than a section of Requests because it is the one part of the
 * old tab that is not about a request: adding a film to the movie manager
 * directly, or deleting one with its files, is editing the machinery rather
 * than asking it for something. The rest of Manage — queue, history, calendar —
 * did answer "has the thing I asked for arrived yet", and lives in Requests →
 * Activity with the requests it belongs to.
 *
 * Administrator-only twice over: the row in Settings is hidden without
 * elevation, and `RequiresAdmin` is the actual control, because a URL can be
 * pasted. Every arr endpoint behind it requires Jellyfin's `RequiresElevation`.
 */
export default function ArrLibraryPage() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<"movie" | "series">("movie");
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const onRefresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ["stingstream"] });
    setRefreshing(false);
  };

  return (
    // The shell rather than `SettingsPage`: this screen owns its own scroll view
    // and a segmented bar above it, and a second scroller around them would give
    // the page two scrollbars and unstick the bar.
    <SettingsShell categoryKey='arr_library'>
      <RequiresAdmin>
        <View style={{ flex: 1 }}>
          <View testID='arr-library-tabs'>
            <SegmentedControlBar
              segments={[
                { key: "movie", label: t("manage.tab_movies") },
                { key: "series", label: t("manage.tab_series") },
              ]}
              value={kind}
              onChange={(v) => setKind(v as "movie" | "series")}
            />
          </View>
          <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
            {/*
              Above the list, and above the segmented control's two halves,
              because it governs both of them: with downloading off there is no
              list to show and the page below is a sentence explaining that. It
              is also where the Requests notice sends an administrator, so it
              has to be the first thing on the screen rather than something to
              scroll for.
            */}
            <FocusTarget id='downloading'>
              <DownloadingSection />
            </FocusTarget>
            {/*
            Keyed on `kind` so switching halves remounts rather than carrying
            the other half's open Add form and expanded row across — the two
            share a component and would otherwise share its local state.
          */}
            <FocusTarget id={["add-title", "remove-title"]}>
              <LibrarySection key={kind} kind={kind} />
            </FocusTarget>
          </RefreshScreen>
        </View>
      </RequiresAdmin>
    </SettingsShell>
  );
}
