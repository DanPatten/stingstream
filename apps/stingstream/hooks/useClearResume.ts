import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner-native";
import {
  clearResumeInData,
  continueWatchingRowDrop,
  withoutItemsInData,
} from "@/utils/continueWatching";
import { logAndCaptureError } from "@/utils/log";
import { watchedInvalidationKeys } from "@/utils/watched";
import { usePlaybackManager } from "./usePlaybackManager";
import { useInvalidatePlaybackProgressCache } from "./useRevalidatePlaybackProgressCache";

/**
 * "Remove from Continue watching": forgets where the reader stopped, and nothing else. The item is
 * not marked watched; its Play button goes back to plain Play with no resume prompt.
 *
 * The same shape as `useSetWatched`: patch every cached copy (and drop it from the Continue
 * watching row where it is leaving for good, `continueWatchingRowDrop`), send the request, roll
 * back with a toast on failure, then refresh everything that can show a position.
 */
export const useClearResume = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { clearItemResumePosition } = usePlaybackManager();
  const invalidatePlaybackProgressCache = useInvalidatePlaybackProgressCache();

  return useCallback(
    async (item: BaseItemDto) => {
      const itemId = item.Id;
      if (!itemId) return;
      const ids = new Set([itemId]);

      const previous: [QueryKey, unknown][] = [];
      for (const query of queryClient.getQueryCache().getAll()) {
        const data = query.state.data;
        if (data === undefined) continue;
        const next = continueWatchingRowDrop(query.queryKey, item, "removed")
          ? withoutItemsInData(data, ids)
          : clearResumeInData(data, ids);
        if (next === data) continue;
        previous.push([query.queryKey, data]);
        queryClient.setQueryData(query.queryKey, next);
      }

      try {
        await clearItemResumePosition(itemId);
      } catch (error) {
        logAndCaptureError("Removing from Continue watching failed", error);
        for (const [queryKey, data] of previous) {
          queryClient.setQueryData(queryKey, data);
        }
        toast.error(t("item.continue_watching_remove_failed"));
      } finally {
        await Promise.all(
          watchedInvalidationKeys([item]).map((queryKey) =>
            queryClient.invalidateQueries({ queryKey: [...queryKey] }),
          ),
        );
        await invalidatePlaybackProgressCache();
      }
    },
    [clearItemResumePosition, invalidatePlaybackProgressCache, queryClient, t],
  );
};
