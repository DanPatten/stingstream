import { describe, expect, test } from "bun:test";
import { formatVersionLabel, pickVersion } from "./appVersionLabel";

describe("pickVersion", () => {
  test("returns the first non-empty candidate", () => {
    expect(pickVersion([null, undefined, "", "0.2.0", "9.9.9"])).toBe("0.2.0");
  });

  test("skips a whitespace-only candidate", () => {
    // `Constants.expoConfig?.version` can resolve to "" rather than undefined on some builds;
    // an all-whitespace string is the same "nothing here" case.
    expect(pickVersion(["   ", "0.2.0"])).toBe("0.2.0");
  });

  test("returns null when every candidate is empty", () => {
    expect(pickVersion([null, undefined, "", "   "])).toBeNull();
  });

  test("an empty candidate list returns null", () => {
    expect(pickVersion([])).toBeNull();
  });
});

describe("formatVersionLabel", () => {
  test("version and build together", () => {
    expect(formatVersionLabel("0.2.0", "2")).toBe("v0.2.0 (2)");
  });

  test("version alone — web has no build-number equivalent", () => {
    expect(formatVersionLabel("0.2.0", null)).toBe("v0.2.0");
  });

  test("no version at all falls back to N/A, never a fabricated version", () => {
    expect(formatVersionLabel(null, "2")).toBe("N/A");
    expect(formatVersionLabel(null, null)).toBe("N/A");
  });
});
