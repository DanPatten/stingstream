import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { FocusTarget } from "@/components/settings/FocusTarget";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { LibrarySection } from "@/components/stingstream/arr/LibrarySection";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";
import { SegmentedControlBar } from "@/components/stingstream/shared/SegmentedControl";

/**
 * The titles this server manages — add, retune, remove.
 *
 * This was the Movies and Series halves of the Manage tab. It is a settings
 * screen rather than a section of Requests because it is the one part of the
 * old tab that is not about a request: adding a movie directly, or deleting one
 * with its files, is editing the machinery rather than asking it for something.
 * The rest of Manage — queue, history, calendar — did answer "has the thing I
 * asked for arrived yet", and lives in Requests → Activity with the requests it
 * belongs to.
 *
 * The downloading switches used to sit on top of this page. They are
 * `/settings/downloading` now: a tab bar that scopes a whole page cannot sit
 * under a control that governs both of its tabs without reading as two screens
 * stuck together.
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
    // the page two scrollbars.
    <SettingsShell categoryKey='arr_library'>
      <RequiresAdmin>
        <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
          {/*
            Inside the scroller, so it sits in the same content column as the
            list it scopes. Outside it, it missed `RefreshScreen`'s
            `PageContainer` and drew hard against the left edge of a wide
            window, a whole column away from the rows it belonged to.
          */}
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
          {/*
            Keyed on `kind` so switching halves remounts rather than carrying
            the other half's open Add form and expanded row across — the two
            share a component and would otherwise share its local state.
          */}
          <FocusTarget id={["add-title", "remove-title"]}>
            <LibrarySection key={kind} kind={kind} />
          </FocusTarget>
        </RefreshScreen>
      </RequiresAdmin>
    </SettingsShell>
  );
}
