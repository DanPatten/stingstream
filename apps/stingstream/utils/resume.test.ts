import { describe, expect, test } from "bun:test";
import {
  formatResumePosition,
  remainingAfterResume,
  resumeFraction,
  resumePositionTicks,
  shouldAskToResume,
} from "./resume";

const TICKS_PER_SECOND = 10_000_000;
const minutes = (value: number) => value * 60 * TICKS_PER_SECOND;

const item = (
  position: number | undefined,
  extra: { played?: boolean; percent?: number; runtime?: number } = {},
) => ({
  RunTimeTicks: extra.runtime ?? minutes(120),
  UserData: {
    PlaybackPositionTicks: position,
    Played: extra.played ?? false,
    PlayedPercentage: extra.percent,
  },
});

describe("resumePositionTicks", () => {
  test("a saved position is the resume point", () => {
    expect(resumePositionTicks(item(minutes(62)))).toBe(minutes(62));
  });

  test("nothing saved, nothing to resume", () => {
    expect(resumePositionTicks(item(0))).toBe(0);
    expect(resumePositionTicks(item(undefined))).toBe(0);
    expect(resumePositionTicks(null)).toBe(0);
    expect(resumePositionTicks(undefined)).toBe(0);
    expect(resumePositionTicks({})).toBe(0);
  });

  test("a watched title starts from the top even with a stale position", () => {
    expect(resumePositionTicks(item(minutes(62), { played: true }))).toBe(0);
  });

  test("a nonsense position is ignored", () => {
    expect(resumePositionTicks(item(-5))).toBe(0);
    expect(resumePositionTicks(item(Number.NaN))).toBe(0);
  });
});

describe("shouldAskToResume", () => {
  test("asks when there is a position and the setting is on or unset", () => {
    expect(shouldAskToResume(item(minutes(10)), { showResumeDialog: true })).toBe(
      true,
    );
    expect(shouldAskToResume(item(minutes(10)), {})).toBe(true);
  });

  test("never asks with nothing to resume", () => {
    expect(shouldAskToResume(item(0), { showResumeDialog: true })).toBe(false);
    expect(
      shouldAskToResume(item(minutes(10), { played: true }), {
        showResumeDialog: true,
      }),
    ).toBe(false);
  });

  test("the reader can turn the question off", () => {
    expect(
      shouldAskToResume(item(minutes(10)), { showResumeDialog: false }),
    ).toBe(false);
  });
});

describe("formatting", () => {
  test("the position is a clock", () => {
    expect(formatResumePosition(minutes(62) + 33 * TICKS_PER_SECOND)).toBe(
      "1:02:33",
    );
    expect(formatResumePosition(minutes(12) + 4 * TICKS_PER_SECOND)).toBe(
      "12:04",
    );
  });

  test("what is left is said the way a person says it", () => {
    expect(remainingAfterResume(item(minutes(28)))).toBe("1h 32m");
    expect(remainingAfterResume(item(0))).toBeNull();
    expect(remainingAfterResume(item(minutes(28), { runtime: 0 }))).toBeNull();
  });

  test("the fraction prefers the server's percentage and falls back to the runtime", () => {
    expect(resumeFraction(item(minutes(30), { percent: 25 }))).toBe(0.25);
    expect(resumeFraction(item(minutes(30)))).toBe(0.25);
    expect(resumeFraction(item(0, { percent: 25 }))).toBe(0);
    expect(resumeFraction(item(minutes(30), { runtime: 0 }))).toBe(0);
    expect(resumeFraction(item(minutes(300)))).toBe(1);
  });
});
