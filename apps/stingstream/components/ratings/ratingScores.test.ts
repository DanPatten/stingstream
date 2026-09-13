import { describe, expect, test } from "bun:test";
import { hasRatings, visibleRatings } from "./ratingScores";

describe("visibleRatings", () => {
  test("draws a community score to one decimal", () => {
    expect(visibleRatings({ community: 8.25 }).community).toBe("8.3");
    expect(visibleRatings({ community: 7 }).community).toBe("7.0");
  });

  test("hides a score that is missing or zero", () => {
    expect(visibleRatings({})).toEqual({ community: null, critics: null });
    expect(visibleRatings({ community: null, critics: null })).toEqual({
      community: null,
      critics: null,
    });
    expect(visibleRatings({ community: 0, critics: 0 })).toEqual({
      community: null,
      critics: null,
    });
  });

  test("a critics' score is fresh from sixty", () => {
    expect(visibleRatings({ critics: 60 }).critics).toEqual({
      score: 60,
      fresh: true,
    });
    expect(visibleRatings({ critics: 59 }).critics).toEqual({
      score: 59,
      fresh: false,
    });
    expect(visibleRatings({ critics: 93.6 }).critics?.score).toBe(94);
  });

  test("either score alone is enough to draw the line", () => {
    expect(hasRatings({})).toBe(false);
    expect(hasRatings({ community: 0, critics: null })).toBe(false);
    expect(hasRatings({ community: 6.1 })).toBe(true);
    expect(hasRatings({ critics: 12 })).toBe(true);
  });
});
