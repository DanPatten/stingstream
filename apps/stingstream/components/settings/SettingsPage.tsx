import { useQueryClient } from "@tanstack/react-query";
import { type PropsWithChildren, useState } from "react";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { SettingsShell } from "./SettingsShell";

/**
 * The scaffolding every settings route repeats, named once.
 *
 * Fourteen route files that each had to remember the category column, the
 * scroll view, the 960 px measure, the safe-area padding and a pull-to-refresh
 * is fourteen chances to forget one — and the one that gets forgotten is always
 * the refresh, because nothing looks wrong until somebody's data is stale.
 *
 * `RequiresAdmin` deliberately goes *inside* this rather than around it: a
 * pasted URL for a category a member cannot open should still show them the
 * settings they can, with the refusal in the pane, instead of a bare sentence
 * on an empty page.
 */
export const SettingsPage: React.FC<
  PropsWithChildren<{
    /** Which navigation row to light. See `buildSettingsCategories`. */
    categoryKey: string;
    /**
     * Query keys to invalidate on pull-to-refresh.
     *
     * Defaults to the whole `["stingstream"]` prefix, which is what the
     * StingStream screens have always done. A pane on Jellyfin's own admin API
     * passes its own key instead — invalidating everything to refresh one
     * document re-fetches the arrs, the mesh and the request queue with it.
     */
    invalidate?: readonly (readonly unknown[])[];
  }>
> = ({ categoryKey, invalidate = [["stingstream"]], children }) => {
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all(
      invalidate.map((queryKey) =>
        queryClient.invalidateQueries({ queryKey: [...queryKey] }),
      ),
    );
    setRefreshing(false);
  };

  return (
    <SettingsShell categoryKey={categoryKey}>
      <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
        {children}
      </RefreshScreen>
    </SettingsShell>
  );
};
