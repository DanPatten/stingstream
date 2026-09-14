import { describe, expect, test } from "bun:test";
import {
  cutoffFor,
  draftOf,
  NEW_PROFILE_DRAFT,
  orderTiers,
  toggleTier,
} from "./qualityTiers";

describe("orderTiers", () => {
  test("keeps known tiers once, worst first", () => {
    expect(orderTiers(["2160p", "sd", "remux", "sd"])).toEqual(["sd", "2160p"]);
  });
});

describe("cutoffFor", () => {
  test("keeps a cutoff that is still allowed", () => {
    expect(cutoffFor(["720p", "1080p"], "720p")).toBe("720p");
  });

  test("moves to the best allowed tier when the cutoff is switched off", () => {
    expect(cutoffFor(["sd", "720p"], "2160p")).toBe("720p");
  });

  test("is empty when nothing is allowed", () => {
    expect(cutoffFor([], "720p")).toBeNull();
  });
});

describe("toggleTier", () => {
  test("adding a tier keeps the order and the cutoff", () => {
    const next = toggleTier(NEW_PROFILE_DRAFT, "sd");
    expect(next.tiers).toEqual(["sd", "720p", "1080p"]);
    expect(next.cutoff).toBe("1080p");
  });

  test("removing the cutoff tier moves the cutoff down", () => {
    const next = toggleTier(NEW_PROFILE_DRAFT, "1080p");
    expect(next.tiers).toEqual(["720p"]);
    expect(next.cutoff).toBe("720p");
  });

  test("the last tier cannot be switched off", () => {
    const one = {
      tiers: ["1080p" as const],
      cutoff: "1080p" as const,
      upgrade: true,
    };
    expect(toggleTier(one, "1080p")).toBe(one);
  });
});

describe("draftOf", () => {
  test("reads a profile as the server reports it", () => {
    expect(
      draftOf({
        Tiers: ["2160p", "1080p"],
        CutoffTier: "2160p",
        UpgradeAllowed: false,
      }),
    ).toEqual({ tiers: ["1080p", "2160p"], cutoff: "2160p", upgrade: false });
  });

  test("a profile whose cutoff is in no tier stops at its best tier", () => {
    expect(draftOf({ Tiers: ["720p"], CutoffTier: "" }).cutoff).toBe("720p");
  });

  test("a profile made of qualities in no tier has nothing selected", () => {
    expect(draftOf({ Tiers: [] })).toEqual({
      tiers: [],
      cutoff: null,
      upgrade: true,
    });
  });
});
