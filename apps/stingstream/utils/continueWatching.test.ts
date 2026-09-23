import { describe, expect, test } from "bun:test";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import {
  canRemoveFromContinueWatching,
  clearResumeInData,
  continueWatchingRowDrop,
  hasResumePosition,
  homeRowMenuContext,
  withoutItemsInData,
  withResumeCleared,
} from "./continueWatching";

const inProgressMovie: BaseItemDto = {
  Id: "m1",
  Type: "Movie",
  UserData: {
    Played: false,
    PlaybackPositionTicks: 5000,
    PlayedPercentage: 30,
  },
};
const inProgressEpisode: BaseItemDto = {
  Id: "e1",
  Type: "Episode",
  SeriesId: "s1",
  UserData: { Played: false, PlaybackPositionTicks: 900, PlayedPercentage: 10 },
};
const nextUpEpisode: BaseItemDto = {
  Id: "e2",
  Type: "Episode",
  SeriesId: "s2",
  UserData: { Played: false, PlaybackPositionTicks: 0 },
};

const MERGED = ["home", "continueAndNextUp"];
const RESUME = ["home", "resumeItems"];
const NEXT_UP = ["home", "nextUp-all"];

describe("which home row a card is in", () => {
  test("the merged row and the resume row are Continue watching", () => {
    expect(homeRowMenuContext(MERGED)).toBe("continueWatching");
    expect(homeRowMenuContext(RESUME)).toBe("continueWatching");
  });

  test("the separate Next up row is Next up", () => {
    expect(homeRowMenuContext(NEXT_UP)).toBe("nextUp");
  });

  test("every other row is neither", () => {
    expect(
      homeRowMenuContext(["home", "suggestedMovies", "u"]),
    ).toBeUndefined();
    expect(homeRowMenuContext(["library-items", "x"])).toBeUndefined();
  });
});

describe("when the menu offers Remove from Continue watching", () => {
  test("an in-progress item in Continue watching", () => {
    expect(
      canRemoveFromContinueWatching(inProgressMovie, "continueWatching"),
    ).toBe(true);
    expect(
      canRemoveFromContinueWatching(inProgressEpisode, "continueWatching"),
    ).toBe(true);
  });

  test("not a Next up episode in the merged row: there is nothing to forget", () => {
    expect(
      canRemoveFromContinueWatching(nextUpEpisode, "continueWatching"),
    ).toBe(false);
  });

  test("not in the Next up row, which the server cannot hide per user", () => {
    expect(canRemoveFromContinueWatching(inProgressEpisode, "nextUp")).toBe(
      false,
    );
  });

  test("not outside the home rows", () => {
    expect(canRemoveFromContinueWatching(inProgressMovie, undefined)).toBe(
      false,
    );
  });

  test("a watched item has no resume position", () => {
    expect(
      hasResumePosition({
        ...inProgressMovie,
        UserData: { Played: true, PlaybackPositionTicks: 5000 },
      }),
    ).toBe(false);
  });
});

describe("removing clears the position and nothing else", () => {
  test("position and percentage go, watched state stays", () => {
    const next = withResumeCleared(inProgressEpisode);
    expect(next.UserData?.PlaybackPositionTicks).toBe(0);
    expect(next.UserData?.PlayedPercentage).toBe(0);
    expect(next.UserData?.Played).toBe(false);
  });
});

describe("what leaves a Continue watching row at once", () => {
  test("the resume-only row drops it for either reason", () => {
    for (const reason of ["watched", "removed"] as const) {
      expect(continueWatchingRowDrop(RESUME, inProgressEpisode, reason)).toBe(
        true,
      );
    }
  });

  test("the merged row drops anything marked watched", () => {
    expect(continueWatchingRowDrop(MERGED, inProgressEpisode, "watched")).toBe(
      true,
    );
  });

  test("the merged row drops a removed movie", () => {
    expect(continueWatchingRowDrop(MERGED, inProgressMovie, "removed")).toBe(
      true,
    );
  });

  test("the merged row keeps a removed episode, which comes back as Next up", () => {
    expect(continueWatchingRowDrop(MERGED, inProgressEpisode, "removed")).toBe(
      false,
    );
  });

  test("no other query drops anything", () => {
    expect(
      continueWatchingRowDrop(["item", "m1"], inProgressMovie, "watched"),
    ).toBe(false);
    expect(continueWatchingRowDrop(NEXT_UP, inProgressMovie, "removed")).toBe(
      false,
    );
  });
});

describe("patching cached rows", () => {
  const pages = {
    pages: [[inProgressMovie, inProgressEpisode], [nextUpEpisode]],
    pageParams: [0, 10],
  };

  test("drops the item from an infinite row's pages", () => {
    const next = withoutItemsInData(pages, new Set(["m1"]));
    expect(next.pages[0].map((i) => i.Id)).toEqual(["e1"]);
    expect(next.pages[1]).toBe(pages.pages[1]);
  });

  test("clears the position everywhere it is cached", () => {
    const next = clearResumeInData(pages, new Set(["e1"]));
    expect(next.pages[0][1].UserData?.PlaybackPositionTicks).toBe(0);
    expect(next.pages[0][0]).toBe(inProgressMovie);
  });

  test("leaves data that never held the item untouched", () => {
    expect(withoutItemsInData(pages, new Set(["zzz"]))).toBe(pages);
    expect(clearResumeInData(pages, new Set(["zzz"]))).toBe(pages);
  });
});
