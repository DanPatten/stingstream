import { describe, expect, test } from "bun:test";
import {
  formatRuntimeTicks,
  formatRuntimeTicksExact,
  runtimeTicksToMinutes,
} from "./time";

// `utils/time.ts` imports nothing, so this needs no react-native stub — which
// is half the reason the runtime formatter belongs here rather than beside the
// component that first needed it.

const TICKS_PER_SECOND = 10_000_000;
const seconds = (value: number) => value * TICKS_PER_SECOND;
const minutes = (value: number) => seconds(value * 60);
const hours = (value: number) => minutes(value * 60);

describe("formatRuntimeTicks", () => {
  test("counts seconds under a minute rather than reporting 0m", () => {
    // The defect this function exists to end: a 20-second seeded clip whose
    // Play button read "0m" (pass-02 F-26), and the same string in the home
    // hero's badge row, which WP4 had to work around locally.
    expect(formatRuntimeTicks(seconds(20))).toBe("20s");
    expect(formatRuntimeTicks(seconds(1))).toBe("1s");
    expect(formatRuntimeTicks(seconds(59))).toBe("59s");
  });

  test("rounds a sub-second runtime up to one second, never to zero", () => {
    expect(formatRuntimeTicks(TICKS_PER_SECOND / 4)).toBe("1s");
  });

  test("counts minutes below an hour", () => {
    expect(formatRuntimeTicks(minutes(1))).toBe("1m");
    expect(formatRuntimeTicks(minutes(34))).toBe("34m");
    expect(formatRuntimeTicks(minutes(59))).toBe("59m");
  });

  test("counts hours and minutes above an hour", () => {
    expect(formatRuntimeTicks(hours(1) + minutes(34))).toBe("1h 34m");
    expect(formatRuntimeTicks(hours(2) + minutes(5))).toBe("2h 5m");
  });

  test("drops a zero minute part and never writes 60m", () => {
    expect(formatRuntimeTicks(hours(2))).toBe("2h");
    // 1h 59m 40s rounds to 60 minutes, which is two hours.
    expect(formatRuntimeTicks(hours(1) + minutes(59) + seconds(40))).toBe("2h");
  });

  test("returns null for a missing or nonsensical runtime", () => {
    expect(formatRuntimeTicks(null)).toBeNull();
    expect(formatRuntimeTicks(undefined)).toBeNull();
    expect(formatRuntimeTicks(0)).toBeNull();
    expect(formatRuntimeTicks(-1)).toBeNull();
  });
});

describe("runtimeTicksToMinutes", () => {
  test("is the same string, for callers that cannot hold a null", () => {
    expect(runtimeTicksToMinutes(hours(1) + minutes(34))).toBe("1h 34m");
    expect(runtimeTicksToMinutes(minutes(25))).toBe("25m");
  });

  test("says seconds under a minute too — it used to floor to 0m", () => {
    expect(runtimeTicksToMinutes(seconds(20))).toBe("20s");
  });

  test("falls back to 0m when there is nothing to say", () => {
    expect(runtimeTicksToMinutes(null)).toBe("0m");
    expect(runtimeTicksToMinutes(0)).toBe("0m");
  });
});

describe("formatRuntimeTicksExact", () => {
  test("says nothing about the seconds when there are none", () => {
    // The defect: every episode row whose runtime landed on a whole minute —
    // which is most of a library — ended in a pointless "0s".
    expect(formatRuntimeTicksExact(minutes(25))).toBe("25m");
    expect(formatRuntimeTicksExact(hours(1) + minutes(2))).toBe("1h 2m");
    expect(formatRuntimeTicksExact(hours(2))).toBe("2h");
  });

  test("says them when there are", () => {
    expect(formatRuntimeTicksExact(minutes(25) + seconds(30))).toBe("25m 30s");
    expect(formatRuntimeTicksExact(hours(1) + minutes(2) + seconds(5))).toBe(
      "1h 2m 5s",
    );
  });

  test("keeps a zero minutes part between hours and seconds", () => {
    // "1h 5s" reads as though a part went missing.
    expect(formatRuntimeTicksExact(hours(1) + seconds(5))).toBe("1h 0m 5s");
  });

  test("counts plain seconds under a minute", () => {
    expect(formatRuntimeTicksExact(seconds(20))).toBe("20s");
    expect(formatRuntimeTicksExact(seconds(1))).toBe("1s");
  });

  test("floors rather than rounds, unlike the badge formatter", () => {
    // A row that is showing seconds must not round the minutes underneath
    // them: 25m 40s is "25m 40s", not "26m 40s".
    expect(formatRuntimeTicksExact(minutes(25) + seconds(40))).toBe("25m 40s");
    expect(formatRuntimeTicks(minutes(25) + seconds(40))).toBe("26m");
  });

  test("returns null when there is no runtime, so a row omits the line", () => {
    expect(formatRuntimeTicksExact(null)).toBeNull();
    expect(formatRuntimeTicksExact(undefined)).toBeNull();
    expect(formatRuntimeTicksExact(0)).toBeNull();
    expect(formatRuntimeTicksExact(-1)).toBeNull();
  });
});
