import { describe, expect, test } from "bun:test";
import { formatClock } from "./formatClock";

describe("formatClock", () => {
  test("writes m:ss under an hour", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(3_000)).toBe("0:03");
    expect(formatClock(17_000)).toBe("0:17");
    expect(formatClock(63_000)).toBe("1:03");
    expect(formatClock(12 * 60_000 + 34_000)).toBe("12:34");
    expect(formatClock(59 * 60_000 + 59_000)).toBe("59:59");
  });

  test("grows to h:mm:ss on the hour, and pads the minutes there", () => {
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(3_600_000 + 2 * 60_000 + 3_000)).toBe("1:02:03");
    expect(formatClock(10 * 3_600_000 + 59 * 60_000 + 59_000)).toBe("10:59:59");
  });

  test("truncates, so the reading never shows a second the movie has not reached", () => {
    expect(formatClock(3_999)).toBe("0:03");
    expect(formatClock(59_999)).toBe("0:59");
  });

  test("anything unusable is the start of the movie, not NaN", () => {
    expect(formatClock(null)).toBe("0:00");
    expect(formatClock(undefined)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("0:00");
    // The sign belongs to the caller -- remaining time is drawn with its own "-".
    expect(formatClock(-5_000)).toBe("0:00");
  });
});
