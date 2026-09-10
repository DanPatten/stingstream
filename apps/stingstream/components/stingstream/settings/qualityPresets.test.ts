import { describe, expect, test } from "bun:test";
import {
  availableGroups,
  inGroup,
  isPresetPresent,
  PRESETS,
  resolvePreset,
} from "./qualityPresets";

/**
 * The ready-made profiles, and the format groups behind them.
 *
 * Worth pinning rather than eyeballing: a preset that quietly resolves to the wrong set of
 * qualities is a server that spends a week downloading twenty-gigabyte remuxes of everything, and
 * nothing on screen would say so — the profile would simply be named "Everyday".
 */

/** A real vocabulary, worst-first, as the managers report it. */
const VOCABULARY = [
  "SDTV",
  "DVD",
  "WEBDL-480p",
  "Bluray-480p",
  "HDTV-720p",
  "WEBRip-720p",
  "WEBDL-720p",
  "Bluray-720p",
  "HDTV-1080p",
  "WEBRip-1080p",
  "WEBDL-1080p",
  "Bluray-1080p",
  "Remux-1080p",
  "HDTV-2160p",
  "WEBDL-2160p",
  "Bluray-2160p",
  "Remux-2160p",
];

const preset = (key: string) => {
  const found = PRESETS.find((p) => p.key === key);
  if (!found) throw new Error(`no preset ${key}`);
  return found;
};

describe("format groups", () => {
  test("a resolution group takes every format at that resolution", () => {
    expect(inGroup(VOCABULARY, "hd1080")).toEqual([
      "HDTV-1080p",
      "WEBRip-1080p",
      "WEBDL-1080p",
      "Bluray-1080p",
      "Remux-1080p",
    ]);
  });

  test("standard definition is the ones with no resolution in the name too", () => {
    expect(inGroup(VOCABULARY, "sd")).toEqual([
      "SDTV",
      "DVD",
      "WEBDL-480p",
      "Bluray-480p",
    ]);
  });

  test("a name can be in two groups, because they answer different questions", () => {
    // How big is the picture, and is it an untouched disc rip.
    expect(inGroup(VOCABULARY, "remux")).toContain("Remux-1080p");
    expect(inGroup(VOCABULARY, "hd1080")).toContain("Remux-1080p");
  });

  test("a group this server cannot offer is not offered", () => {
    expect(availableGroups(["HDTV-720p", "WEBDL-720p"])).toEqual(["hd720"]);
  });
});

describe("resolvePreset", () => {
  test("Everyday is 720p and 1080p, and stops at the best 1080p", () => {
    const resolved = resolvePreset(preset("everyday"), VOCABULARY);
    expect(resolved?.allowed).toContain("WEBDL-1080p");
    expect(resolved?.allowed).toContain("HDTV-720p");
    // The two that would surprise somebody who picked the everyday option.
    expect(resolved?.allowed).not.toContain("SDTV");
    expect(resolved?.allowed).not.toContain("Remux-2160p");
    expect(resolved?.cutoff).toBe("Remux-1080p");
  });

  test("Everyday deliberately excludes nothing at 1080p, remux included", () => {
    // Remux-1080p is 1080p, so it is allowed — what "Everyday" excludes is 4K and SD. The cutoff
    // being the top of the 1080p range is what stops it climbing past that.
    const resolved = resolvePreset(preset("everyday"), VOCABULARY);
    expect(resolved?.allowed).toContain("Remux-1080p");
  });

  test("4K keeps 1080p, so a title with no 4K release still arrives", () => {
    const resolved = resolvePreset(preset("uhd"), VOCABULARY);
    expect(resolved?.allowed).toContain("WEBDL-1080p");
    expect(resolved?.allowed).toContain("Bluray-2160p");
    expect(resolved?.cutoff).toBe("Remux-2160p");
  });

  test("Anything takes everything the server offers", () => {
    const resolved = resolvePreset(preset("anything"), VOCABULARY);
    expect(resolved?.allowed).toEqual(VOCABULARY);
  });

  test("the cutoff falls back to the best allowed when its group is missing", () => {
    // A server with no 4K at all still gets a profile that stops climbing, rather than one that
    // replaces a good file with a marginally better one forever.
    const noUhd = VOCABULARY.filter((q) => !q.includes("2160p"));
    const resolved = resolvePreset(preset("uhd"), noUhd);
    expect(resolved?.cutoff).toBe("Remux-1080p");
  });

  test("a preset this server can offer nothing for resolves to nothing", () => {
    expect(resolvePreset(preset("uhd"), ["SDTV", "DVD"])).toBeNull();
  });

  test("an empty vocabulary is not an error", () => {
    // It means the managers have not answered yet, which is a wait rather than a fault.
    for (const p of PRESETS) {
      expect(resolvePreset(p, [])).toBeNull();
    }
  });
});

describe("isPresetPresent", () => {
  test("a preset already on the server is not offered again", () => {
    expect(isPresetPresent(preset("everyday"), ["Everyday", "4K"])).toBe(true);
  });

  test("matching ignores case and stray spacing, because the managers do", () => {
    expect(isPresetPresent(preset("everyday"), ["  everyday "])).toBe(true);
  });

  test("a profile somebody made themselves is not mistaken for a preset", () => {
    expect(isPresetPresent(preset("everyday"), ["Everyday 4K"])).toBe(false);
  });
});
