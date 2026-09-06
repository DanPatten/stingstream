import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Bug 1 of the v0.2.0 plan: every header icon in the browser was an empty box.
//
// `expo-symbols`' cross-platform build picks the name with
// `props.name[Platform.OS === "android" ? "android" : "web"]`
// (node_modules/expo-symbols/build/SymbolView.js) and renders `props.fallback`
// — for most of these entries, nothing at all — when that key is missing. The
// registry only ever carried `ios` and `android`, so the web bundle drew
// nothing where six header buttons should have been, silently and with no
// console error to find it by.
//
// A screenshot cannot guard this: the icons live on signed-in screens, and a
// missing glyph looks exactly like a blank header. So the registry is checked
// as source text, the way `CLAUDE.test.ts` and `assets/bundled-assets.test.ts`
// check the lists they pin. `HeaderIcon.tsx` itself cannot be imported here —
// it pulls in react-native and expo-symbols, which `bun:test` cannot load.

const source = readFileSync(join(__dirname, "HeaderIcon.tsx"), "utf8");
const registry = source.slice(
  source.indexOf("const HEADER_ICONS = {"),
  source.indexOf("} as const;"),
);

/** `{ ios: "heart", android: "favorite", web: "favorite" }` per entry name. */
const entries = [...registry.matchAll(/^\s{2}(\w+):\s*\{([^}]*)\}/gms)].map(
  ([, name, body]) => ({
    name,
    platforms: Object.fromEntries(
      [...body.matchAll(/(ios|android|web):\s*"([^"]+)"/g)].map(
        ([, platform, symbol]) => [platform, symbol],
      ),
    ) as Record<string, string | undefined>,
  }),
);

describe("HEADER_ICONS", () => {
  test("the scan finds the registry", () => {
    // Guards the parsing itself: a rename or a reformat that made the regex
    // match nothing would otherwise turn every test below green and useless.
    expect(entries.length).toBeGreaterThanOrEqual(19);
    expect(entries.map((entry) => entry.name)).toContain("cast");
    expect(entries.map((entry) => entry.name)).toContain("back");
  });

  test("every entry names a symbol for web", () => {
    const blank = entries
      .filter((entry) => !entry.platforms.web)
      .map((entry) => entry.name);
    // A non-empty list here names the header icons that render as nothing in a
    // browser. Add `web:` with the same Material Symbols name as `android:`.
    expect(blank).toEqual([]);
  });

  test("web and android name the same Material Symbol", () => {
    // They read from one font. Two different names would mean two different
    // glyphs for the same idea on two surfaces of the same app.
    const mismatched = entries
      .filter((entry) => entry.platforms.web !== entry.platforms.android)
      .map((entry) => entry.name);
    expect(mismatched).toEqual([]);
  });
});
