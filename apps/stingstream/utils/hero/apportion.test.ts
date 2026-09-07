import { describe, expect, test } from "bun:test";
import { apportion } from "./apportion";

describe("apportion", () => {
  test("parts always sum to the total", () => {
    for (const total of [0, 1, 3, 7, 10, 23]) {
      const result = apportion(total, [
        ["a", 2],
        ["b", 2],
        ["c", 6],
      ]);
      const sum = result.a + result.b + result.c;
      expect(sum).toBe(total);
    }
  });

  test("splits the hero's ten slides 2 / 2 / 6", () => {
    expect(
      apportion(10, [
        ["continueWatching", 2],
        ["nextUp", 2],
        ["recentlyAdded", 6],
      ]),
    ).toEqual({ continueWatching: 2, nextUp: 2, recentlyAdded: 6 });
  });

  test("a dropped group's share goes to the ones that remain, not to nobody", () => {
    // Hiding Next Up must not shorten the carousel to eight slides.
    const result = apportion(10, [
      ["continueWatching", 2],
      ["recentlyAdded", 6],
    ]);
    expect(result.continueWatching + result.recentlyAdded).toBe(10);
    expect(result.recentlyAdded).toBeGreaterThan(6);
  });

  test("a single group takes everything", () => {
    expect(apportion(10, [["recentlyAdded", 6]])).toEqual({
      recentlyAdded: 10,
    });
  });

  test("equal remainders break towards the earlier entry", () => {
    // 10 / 3 = 3.33 each: three whole slides each and one left over, which the
    // first-listed group gets because the remainder sort is stable.
    const result = apportion(10, [
      ["a", 1],
      ["b", 1],
      ["c", 1],
    ]);
    expect(result).toEqual({ a: 4, b: 3, c: 3 });
  });

  test("no weights at all is zeroes, not a crash or a NaN", () => {
    expect(apportion(10, [])).toEqual({});
    expect(
      apportion(10, [
        ["a", 0],
        ["b", 0],
      ]),
    ).toEqual({ a: 0, b: 0 });
  });

  test("a zero total gives every group nothing", () => {
    expect(
      apportion(0, [
        ["a", 2],
        ["b", 6],
      ]),
    ).toEqual({ a: 0, b: 0 });
  });

  test("weights decide the split, not the order", () => {
    const result = apportion(8, [
      ["small", 1],
      ["big", 3],
    ]);
    expect(result).toEqual({ small: 2, big: 6 });
  });
});
