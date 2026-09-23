import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner-native";
import {
  continueWatchingRowDrop,
  mapItemsInData,
} from "@/utils/continueWatching";
import { logAndCaptureError } from "@/utils/log";
import {
  isAffectedBy,
  patchWatchedInData,
  watchedInvalidationKeys,
} from "@/utils/watched";
import { useHaptic } from "./useHaptic";
import { usePlaybackManager } from "./usePlaybackManager";
import { useInvalidatePlaybackProgressCache } from "./useRevalidatePlaybackProgressCache";

/**
 * Marks items watched or unwatched, for the items it is handed at call time.
 *
 * The one implementation behind the title page's check, the "..." rows, the card menus and the TV
 * long-press, so they all update the same caches the same way.
 *
 * 1. **Optimistic, everywhere at once.** Every cached query that holds a copy of an affected item
 *    (the item, or an episode inside a marked show or season) is patched before the request goes,
 *    so the poster's badge, the progress bar and the page's own toggle all flip together rather
 *    than one screen at a time as each refetch lands.
 * 2. **One request per item.** The server recurses for a show or a season (`utils/watched.ts`).
 * 3. **Then the truth.** Every query that can show the result is invalidated, which is what fixes
 *    the parent's unwatched count and moves the item into or out of Continue watching and Next up.
 *    A failure puts back every query it patched and says so.
 */
export const useSetWatched = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const lightHapticFeedback = useHaptic("light");
  const { markItemPlayed, markItemUnplayed } = usePlaybackManager();
  const invalidatePlaybackProgressCache = useInvalidatePlaybackProgressCache();

  return useCallback(
    async (items: BaseItemDto[], played: boolean) => {
      const targets = items.filter(
        (
          item,
        ): item is BaseItemDto & {
          Id: string;
        } => Boolean(item.Id),
      );
      if (targets.length === 0) return;

      lightHapticFeedback();

      // Snapshot only what the patch actually changes, so a rollback cannot clobber an unrelated
      // query that refetched in the meantime.
      const previous: [QueryKey, unknown][] = [];
      for (const query of queryClient.getQueryCache().getAll()) {
        const data = query.state.data;
        if (data === undefined) continue;
        // Watched leaves Continue watching at once (Plex's "Mark as watched" on that row); the
        // episode after it arrives with the refetch.
        const leavesRow =
          played &&
          continueWatchingRowDrop(query.queryKey, targets[0], "watched");
        const patched = leavesRow
          ? mapItemsInData(data, (item) =>
              targets.some((target) => isAffectedBy(item, target))
                ? null
                : item,
            )
          : patchWatchedInData(data, targets, played);
        if (patched === data) continue;
        previous.push([query.queryKey, data]);
        queryClient.setQueryData(query.queryKey, patched);
      }

      try {
        await Promise.all(
          targets.map((item) =>
            played ? markItemPlayed(item.Id) : markItemUnplayed(item.Id),
          ),
        );
      } catch (error) {
        logAndCaptureError("Marking item played/unplayed failed", error, {
          played,
          itemCount: targets.length,
        });
        for (const [queryKey, data] of previous) {
          queryClient.setQueryData(queryKey, data);
        }
        toast.error(t("item.watched_update_failed"));
      } finally {
        await Promise.all(
          watchedInvalidationKeys(targets).map((queryKey) =>
            queryClient.invalidateQueries({ queryKey: [...queryKey] }),
          ),
        );
        // Also brings a downloaded copy's own watched state into line with the server's.
        await invalidatePlaybackProgressCache();
      }
    },
    [
      invalidatePlaybackProgressCache,
      lightHapticFeedback,
      markItemPlayed,
      markItemUnplayed,
      queryClient,
      t,
    ],
  );
};
