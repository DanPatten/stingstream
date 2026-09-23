import { describe, expect, test } from "bun:test";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import {
  canMarkWatched,
  isAffectedBy,
  isWatched,
  patchWatchedInData,
  unwatchedCountLabel,
  watchedBadge,
  watchedInvalidationKeys,
  watchedToggleLabelKey,
  withWatchedState,
} from "./watched";

const movie = (userData: BaseItemDto["UserData"] = {}): BaseItemDto => ({
  Id: "m1",
  Type: "Movie",
  UserData: userData,
});
const show: BaseItemDto = {
  Id: "s1",
  Type: "Series",
  UserData: { Played: false, UnplayedItemCount: 5 },
};
const season: BaseItemDto = {
  Id: "se1",
  Type: "Season",
  SeriesId: "s1",
  UserData: { Played: false, UnplayedItemCount: 3 },
};
const episode: BaseItemDto = {
  Id: "e1",
  Type: "Episode",
  SeriesId: "s1",
  SeasonId: "se1",
  ParentId: "se1",
  UserData: {
    Played: false,
    PlaybackPositionTicks: 1234,
    PlayedPercentage: 40,
  },
};
const otherEpisode: BaseItemDto = {
  Id: "e9",
  Type: "Episode",
  SeriesId: "s2",
  SeasonId: "se9",
  UserData: { Played: false },
};

describe("the toggle's label", () => {
  test("offers to mark watched when unwatched", () => {
    expect(watchedToggleLabelKey([movie({ Played: false })])).toBe(
      "item.mark_watched",
    );
  });

  test("offers to finish a partly watched item rather than to clear it", () => {
    expect(
      watchedToggleLabelKey([movie({ Played: false, PlayedPercentage: 40 })]),
    ).toBe("item.mark_watched");
  });

  test("offers to mark unwatched only when everything is watched", () => {
    expect(watchedToggleLabelKey([movie({ Played: true })])).toBe(
      "item.mark_unwatched",
    );
    expect(
      watchedToggleLabelKey([
        { ...episode, UserData: { Played: true } },
        { ...otherEpisode, UserData: { Played: false } },
      ]),
    ).toBe("item.mark_watched");
  });

  test("an empty set is never watched", () => {
    expect(isWatched([])).toBe(false);
  });
});

describe("which items can be marked", () => {
  test("movies, shows, seasons and episodes", () => {
    for (const item of [movie(), show, season, episode]) {
      expect(canMarkWatched(item)).toBe(true);
    }
  });

  test("not people, folders or an item without an id", () => {
    expect(canMarkWatched({ Id: "p", Type: "Person" })).toBe(false);
    expect(canMarkWatched({ Id: "f", Type: "CollectionFolder" })).toBe(false);
    expect(canMarkWatched({ Type: "Movie" })).toBe(false);
    expect(canMarkWatched(null)).toBe(false);
  });
});

describe("the poster's corner badge", () => {
  test("a watched movie or episode gets the check", () => {
    expect(watchedBadge(movie({ Played: true }))).toEqual({ kind: "watched" });
    expect(watchedBadge({ ...episode, UserData: { Played: true } })).toEqual({
      kind: "watched",
    });
  });

  test("an unwatched or partly watched movie gets nothing: its bar says it", () => {
    expect(watchedBadge(movie({ Played: false }))).toBeNull();
    expect(watchedBadge(movie({ PlayedPercentage: 50 }))).toBeNull();
  });

  test("a show or season with episodes left gets the count", () => {
    expect(watchedBadge(show)).toEqual({ kind: "unwatchedCount", count: 5 });
    expect(watchedBadge(season)).toEqual({ kind: "unwatchedCount", count: 3 });
  });

  test("a finished show gets the check, not a zero", () => {
    expect(
      watchedBadge({
        ...show,
        UserData: { Played: true, UnplayedItemCount: 0 },
      }),
    ).toEqual({ kind: "watched" });
  });

  test("things with no watched state get nothing", () => {
    expect(
      watchedBadge({ Id: "p", Type: "Person", UserData: { Played: true } }),
    ).toBeNull();
  });

  test("the count is capped", () => {
    expect(unwatchedCountLabel(7)).toBe("7");
    expect(unwatchedCountLabel(1500)).toBe("1k+");
  });
});

describe("what marking changes", () => {
  test("a show covers its seasons and episodes, and nothing else", () => {
    expect(isAffectedBy(show, show)).toBe(true);
    expect(isAffectedBy(season, show)).toBe(true);
    expect(isAffectedBy(episode, show)).toBe(true);
    expect(isAffectedBy(otherEpisode, show)).toBe(false);
  });

  test("a season covers its episodes, not its show", () => {
    expect(isAffectedBy(episode, season)).toBe(true);
    expect(isAffectedBy(show, season)).toBe(false);
    expect(isAffectedBy(otherEpisode, season)).toBe(false);
  });

  test("an episode covers only itself", () => {
    expect(isAffectedBy(episode, episode)).toBe(true);
    expect(isAffectedBy(season, episode)).toBe(false);
  });

  test("both directions clear the resume position", () => {
    for (const played of [true, false]) {
      const next = withWatchedState(episode, played);
      expect(next.UserData?.Played).toBe(played);
      expect(next.UserData?.PlaybackPositionTicks).toBe(0);
      expect(next.UserData?.PlayedPercentage).toBe(0);
    }
  });

  test("watched empties a show's count; unwatched leaves it to the server", () => {
    expect(withWatchedState(show, true).UserData?.UnplayedItemCount).toBe(0);
    expect(withWatchedState(show, false).UserData?.UnplayedItemCount).toBe(5);
  });
});

describe("patching cached queries", () => {
  test("reaches items inside an infinite query's pages", () => {
    const data = {
      pages: [{ Items: [episode, otherEpisode] }],
      pageParams: [0],
    };
    const next = patchWatchedInData(data, [show], true);
    expect(next).not.toBe(data);
    expect(next.pages[0].Items[0].UserData?.Played).toBe(true);
    // Untouched entries keep their identity, so their cards do not re-render.
    expect(next.pages[0].Items[1]).toBe(otherEpisode);
  });

  test("returns the same reference when nothing in it is affected", () => {
    const data = [otherEpisode, { Id: "x", Type: "Movie" }];
    expect(patchWatchedInData(data, [show], true)).toBe(data);
    const scalar = 3;
    expect(patchWatchedInData(scalar, [show], true)).toBe(3);
  });

  test("patches a single cached item", () => {
    const next = patchWatchedInData(movie({ Played: false }), [movie()], true);
    expect(next.UserData?.Played).toBe(true);
  });
});

describe("which queries to refresh", () => {
  const prefixes = (items: BaseItemDto[]) =>
    watchedInvalidationKeys(items).map((key) => key[0]);

  test("any item refreshes itself, Continue watching, Next up, home and every grid", () => {
    const keys = prefixes([movie()]);
    for (const key of [
      "item",
      "resumeItems",
      "nextUp",
      "nextUp-all",
      "home",
      "library-items",
      "collection-items",
      "search",
      "favorites",
    ]) {
      expect(keys).toContain(key);
    }
  });

  test("a movie leaves the show page alone", () => {
    expect(prefixes([movie()])).not.toContain("seasons");
  });

  test("a show, season or episode also refreshes the show page", () => {
    for (const item of [show, season, episode]) {
      const keys = prefixes([item]);
      for (const key of ["series", "seasons", "episodes", "AllEpisodes"]) {
        expect(keys).toContain(key);
      }
    }
  });
});
