import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useCallback } from "react";
import { useSetWatched } from "./useSetWatched";

/**
 * `useSetWatched`, bound to the items a component already holds. `toggle(true)` marks them all
 * watched, `toggle(false)` unwatched.
 */
export const useMarkAsPlayed = (items: BaseItemDto[]) => {
  const setWatched = useSetWatched();
  return useCallback(
    (played: boolean) => setWatched(items, played),
    [items, setWatched],
  );
};
