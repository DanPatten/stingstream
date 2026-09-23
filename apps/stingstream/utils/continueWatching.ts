import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";

/**
 * Dismissing something from Continue watching, the way Plex does: from a card's menu, either
 * "Mark as watched" (it is finished) or "Remove from Continue watching" (forget where you stopped,
 * so Play starts from the beginning with no resume prompt, and nothing is marked watched).
 *
 * Pure, pinned by `continueWatching.test.ts`. The hook is `hooks/useClearResume.ts`; marking
 * watched is `hooks/useSetWatched.ts`, which uses `continueWatchingRowDrop` too.
 *
 * **What the server does.** Its resume list is every item with a position that is not played
 * (`UserDataManager`), so "remove" is `POST /UserItems/{id}/UserData` with
 * `PlaybackPositionTicks: 0`, which touches nothing else. `DELETE /UserPlayedItems` would also do it
 * but resets the play count and last-played date, which is "mark unwatched", not "remove".
 *
 * **Next up is not hidden.** The server has no per-user "hide from Next up", and Next up is worked
 * out from the last *watched* episode. So an episode removed from Continue watching comes back in
 * the merged row as its show's next episode whenever an earlier one was watched, from the start and
 * with no progress bar: exactly "back to just Play". The dedicated Next up row gets no remove row.
 */

/** Which home row a card sits in, for the menu rows only that row has. */
export type ItemCardMenuContext = "continueWatching" | "nextUp";

/** The merged "Continue watching" row, and the resume-only one when the rows are split. */
const MERGED_ROW = "continueAndNextUp";
const RESUME_ROW = "resumeItems";
const NEXT_UP_ROW = "nextUp-all";

/** The home row a query key belongs to, from `components/home/Home.tsx`'s own keys. */
export const homeRowMenuContext = (
  queryKey: readonly unknown[],
): ItemCardMenuContext | undefined => {
  if (queryKey[0] !== "home") return undefined;
  if (queryKey[1] === MERGED_ROW || queryKey[1] === RESUME_ROW) {
    return "continueWatching";
  }
  if (queryKey[1] === NEXT_UP_ROW) return "nextUp";
  return undefined;
};

/** Part way through and not finished: what puts an item in Continue watching. */
export const hasResumePosition = (item: BaseItemDto) =>
  item.UserData?.Played !== true &&
  (item.UserData?.PlaybackPositionTicks ?? 0) > 0;

/**
 * Whether the card menu offers "Remove from Continue watching". Only in that row, and only for an
 * item with somewhere to resume from: in the merged row a Next up episode has none, and removing
 * it would do nothing.
 */
export const canRemoveFromContinueWatching = (
  item: BaseItemDto,
  context: ItemCardMenuContext | undefined,
) => context === "continueWatching" && hasResumePosition(item);

/** The item once its position is forgotten. Watched state untouched. */
export const withResumeCleared = (item: BaseItemDto): BaseItemDto => ({
  ...item,
  UserData: {
    ...item.UserData,
    PlaybackPositionTicks: 0,
    PlayedPercentage: 0,
  },
});

/** Why an item is leaving Continue watching. */
export type ContinueWatchingDrop = "watched" | "removed";

/**
 * Whether a Continue watching row's cache should drop the item at once, before the refetch.
 *
 * - The resume-only row: always. Neither a watched item nor one with no position is in it.
 * - The merged row, watched: always. The episode after it arrives with the refetch.
 * - The merged row, removed: a movie goes. An episode stays, as its show's Next up from the start
 *   (see the file's note), so it is patched rather than dropped and does not blink out and back.
 */
export const continueWatchingRowDrop = (
  queryKey: readonly unknown[],
  item: BaseItemDto,
  reason: ContinueWatchingDrop,
): boolean => {
  if (queryKey[0] !== "home") return false;
  if (queryKey[1] === RESUME_ROW) return true;
  if (queryKey[1] === MERGED_ROW) {
    return reason === "watched" || item.Type !== "Episode";
  }
  return false;
};

const MAX_DEPTH = 6;

const isPlainObject = (value: object) => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Maps every item-shaped object inside cached query data (an item, an array, `{ Items }`, an
 * infinite query's `{ pages }`) through `fn`, and drops those it returns `null` for. Returns the
 * same reference when nothing changed, so a query that never held the item does not update.
 */
export const mapItemsInData = <T>(
  data: T,
  fn: (item: BaseItemDto) => BaseItemDto | null,
  depth = 0,
): T => {
  if (data == null || typeof data !== "object" || depth > MAX_DEPTH) {
    return data;
  }

  if (Array.isArray(data)) {
    let changed = false;
    const next: unknown[] = [];
    for (const entry of data) {
      const mapped = mapItemsInData(entry, fn, depth + 1);
      if (mapped !== entry) changed = true;
      if (mapped !== null) next.push(mapped);
    }
    return (changed ? next : data) as T;
  }

  const record = data as Record<string, unknown>;
  if (typeof record.Id === "string" && typeof record.Type === "string") {
    return fn(data as BaseItemDto) as T;
  }

  if (!isPlainObject(data)) return data;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const mapped = mapItemsInData(value, fn, depth + 1);
    if (mapped !== value) changed = true;
    next[key] = mapped;
  }
  return (changed ? next : data) as T;
};

/** Every cached copy of these items with its position forgotten. */
export const clearResumeInData = <T>(data: T, ids: ReadonlySet<string>): T =>
  mapItemsInData(data, (item) =>
    item.Id && ids.has(item.Id) ? withResumeCleared(item) : item,
  );

/** These items taken out of a row's cached pages. */
export const withoutItemsInData = <T>(data: T, ids: ReadonlySet<string>): T =>
  mapItemsInData(data, (item) => (item.Id && ids.has(item.Id) ? null : item));
