import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";

/**
 * Watched state, the way Plex does it: every movie, show, season and episode can be marked
 * watched or unwatched, a show or a season marks every episode in it, and marking unwatched also
 * clears the resume position.
 *
 * Pure, so the decisions (the label, the badge, what to patch and what to refetch) are pinned by
 * `watched.test.ts` without a React tree. The hook that does the work is `hooks/useSetWatched.ts`.
 *
 * The recursion is the media server's own. `POST`/`DELETE /UserPlayedItems/{id}` on a Series or a
 * Season goes through `Folder.MarkPlayed` / `Folder.MarkUnplayed`, which walk every non-folder
 * child for the user, and `BaseItem.MarkUnplayed` resets the play count and the position
 * (`server/jellyfin/MediaBrowser.Controller/Entities/Folder.cs`, `BaseItem.cs`). The client sends
 * one request per item it was asked about and never walks the children itself.
 *
 * Watched state is per user and lives on the reader's own node. A title held by a connected server
 * is materialised into the local library as a local item (`docs/ARCHITECTURE.md`, "Federated
 * library"), so marking it is the same local request as for anything else, with no fan-out.
 */

/** The item types that carry a watched state a person can set. */
const MARKABLE_TYPES = new Set<string>([
  "Movie",
  "Episode",
  "Series",
  "Season",
  "Video",
  "MusicVideo",
]);

/** Types whose watched state is the sum of their episodes. */
const AGGREGATE_TYPES = new Set<string>(["Series", "Season", "BoxSet"]);

export const canMarkWatched = (item: BaseItemDto | null | undefined) =>
  Boolean(item?.Id && item.Type && MARKABLE_TYPES.has(item.Type));

export const isAggregateItem = (item: BaseItemDto) =>
  Boolean(item.Type && AGGREGATE_TYPES.has(item.Type));

/**
 * Whether a set of items reads as watched. All of them have to be: a season with one episode left
 * is not watched, and its toggle offers to finish it.
 */
export const isWatched = (items: BaseItemDto[]) =>
  items.length > 0 && items.every((item) => item.UserData?.Played === true);

/**
 * The translation key for the toggle. "Mark as watched" when unwatched or partly watched, which
 * finishes it; "Mark as unwatched" only when everything is watched.
 */
export const watchedToggleLabelKey = (
  items: BaseItemDto[],
): "item.mark_watched" | "item.mark_unwatched" =>
  isWatched(items) ? "item.mark_unwatched" : "item.mark_watched";

/** What the corner of a poster says about watched state. */
export type WatchedBadge =
  | { kind: "watched" }
  | { kind: "unwatchedCount"; count: number }
  | null;

/**
 * The corner badge for an item.
 *
 * - Watched, anything markable or aggregate: a check.
 * - A show, season or collection with episodes left: how many.
 * - Anything else, including a partly watched movie (its progress bar says that): nothing. An
 *   unwatched movie gets no mark, because a whole library of them is unwatched and a mark on every
 *   poster says nothing.
 */
export const watchedBadge = (item: BaseItemDto): WatchedBadge => {
  const aggregate = isAggregateItem(item);
  if (!aggregate && !canMarkWatched(item)) return null;
  if (item.UserData?.Played === true) return { kind: "watched" };
  if (aggregate) {
    const count = item.UserData?.UnplayedItemCount ?? 0;
    if (count > 0) return { kind: "unwatchedCount", count };
  }
  return null;
};

/** The count badge's text, capped so it stays a badge. */
export const unwatchedCountLabel = (count: number) =>
  count >= 1000 ? "1k+" : String(count);

/**
 * Whether `candidate` is `target` or sits inside it, so marking `target` changes it too: an episode
 * of a marked show or season.
 */
export const isAffectedBy = (
  candidate: BaseItemDto,
  target: BaseItemDto,
): boolean => {
  if (!target.Id || !candidate.Id) return false;
  if (candidate.Id === target.Id) return true;
  if (target.Type === "Series") {
    return candidate.SeriesId === target.Id;
  }
  if (target.Type === "Season") {
    return (
      candidate.Type === "Episode" &&
      (candidate.SeasonId === target.Id || candidate.ParentId === target.Id)
    );
  }
  return false;
};

/**
 * The item as it will be once the server has it. Both directions clear the resume position: a
 * watched item has nothing to resume, and unwatched starts again from the beginning.
 */
export const withWatchedState = (
  item: BaseItemDto,
  played: boolean,
): BaseItemDto => ({
  ...item,
  UserData: {
    ...item.UserData,
    Played: played,
    PlaybackPositionTicks: 0,
    PlayedPercentage: 0,
    // Watched leaves nothing unwatched. Unwatched is left to the refetch: the count of episodes
    // it holds is not something the client knows.
    ...(played && isAggregateItem(item) ? { UnplayedItemCount: 0 } : {}),
  },
});

const looksLikeItem = (value: object): value is BaseItemDto =>
  typeof (value as BaseItemDto).Id === "string" &&
  typeof (value as BaseItemDto).Type === "string";

/** Deep enough for `{ pages: [{ Items: [item] }] }`, with room to spare. */
const MAX_PATCH_DEPTH = 6;

/**
 * Applies the new watched state to every copy of the affected items inside one query's cached
 * data, whatever shape it has: an item, an array, `{ Items }`, an infinite query's `{ pages }`.
 *
 * Returns the same reference when nothing in it changed, so React Query sees no update and no card
 * re-renders for a query that never held the item.
 */
export const patchWatchedInData = <T>(
  data: T,
  targets: BaseItemDto[],
  played: boolean,
  depth = 0,
): T => {
  if (data == null || typeof data !== "object" || depth > MAX_PATCH_DEPTH) {
    return data;
  }

  if (Array.isArray(data)) {
    let changed = false;
    const next = data.map((entry) => {
      const patched = patchWatchedInData(entry, targets, played, depth + 1);
      if (patched !== entry) changed = true;
      return patched;
    });
    return (changed ? next : data) as T;
  }

  if (looksLikeItem(data)) {
    return (
      targets.some((target) => isAffectedBy(data, target))
        ? withWatchedState(data, played)
        : data
    ) as T;
  }

  // Only plain containers. A Date, a Map or a class instance is left alone.
  const proto = Object.getPrototypeOf(data);
  if (proto !== Object.prototype && proto !== null) return data;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const patched = patchWatchedInData(value, targets, played, depth + 1);
    if (patched !== value) changed = true;
    next[key] = patched;
  }
  return (changed ? next : data) as T;
};

/**
 * Every React Query key whose data can show a watched state that marking these items changes.
 * Each is a prefix, so `["item"]` covers `["item", id, fields]`.
 *
 * Always: the items themselves, Continue watching and Next up (a watched episode leaves them, an
 * unwatched one can come back), the home rows, every library grid, collection, search result and
 * favourites list a card with a badge sits in, and the rows on a details page.
 *
 * A show, season or episode also changes its show page: the seasons and their counts, the episode
 * lists, and the show's own count.
 */
export const watchedInvalidationKeys = (
  items: BaseItemDto[],
): readonly (readonly string[])[] => {
  const keys: string[][] = [
    ["item"],
    ["resumeItems"],
    ["continueWatching"],
    ["nextUp-all"],
    ["nextUp"],
    ["nextItem"],
    ["home"],
    ["library-items"],
    ["collection-items"],
    ["search"],
    ["favorites"],
    ["similarItems"],
    ["downloadedItems"],
  ];

  const touchesShow = items.some(
    (item) =>
      item.Type === "Series" ||
      item.Type === "Season" ||
      item.Type === "Episode",
  );
  if (touchesShow) {
    keys.push(
      ["series"],
      ["seasons"],
      ["episodes"],
      ["AllEpisodes"],
      ["adjacentItems"],
    );
  }

  return keys;
};
