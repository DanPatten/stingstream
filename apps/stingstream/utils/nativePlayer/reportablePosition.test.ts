import { describe, expect, test } from "bun:test";
import { reportablePositionTicks } from "./reportablePosition";

const HOUR = 36_000_000_000;

describe("reportablePositionTicks", () => {
  test("once playing, the player's own position is reported", () => {
    expect(reportablePositionTicks(HOUR + 5, HOUR, true)).toBe(HOUR + 5);
    expect(reportablePositionTicks(12, 0, true)).toBe(12);
  });

  test("a report before playback starts keeps the resume point instead of 0", () => {
    // The web player's first event, before the resume seek landed.
    expect(reportablePositionTicks(0, HOUR, false)).toBe(HOUR);
    // A stale non-zero value from before the start is not trusted either.
    expect(reportablePositionTicks(50, HOUR, false)).toBe(HOUR);
  });

  test("a zero position mid-session never wipes the resume point", () => {
    expect(reportablePositionTicks(0, HOUR, true)).toBe(HOUR);
  });

  test("a title started from the beginning reports from the beginning", () => {
    expect(reportablePositionTicks(0, 0, false)).toBe(0);
    expect(reportablePositionTicks(0, 0, true)).toBe(0);
  });

  test("nonsense input is clamped rather than sent", () => {
    expect(reportablePositionTicks(Number.NaN, HOUR, true)).toBe(HOUR);
    expect(reportablePositionTicks(-10, 0, true)).toBe(0);
    expect(reportablePositionTicks(10, Number.NaN, false)).toBe(10);
  });
});
