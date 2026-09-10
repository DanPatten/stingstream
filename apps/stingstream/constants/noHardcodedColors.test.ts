import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/**
 * Colour comes from the theme, not from a class and not from a hex.
 *
 * The fork arrived with nine colours in `Colors.ts`, `tokens.color.*` read in
 * eighty files, and 500-odd Tailwind palette classes. None of that could follow
 * a theme: NativeWind v2 compiles classes once, at build time, so
 * `bg-neutral-900` is one answer for everybody, and a module-scope constant is
 * whatever the bundle was built with. That is fine in a dark-only app and
 * invisible until the day a light theme lands, at which point half the screens
 * stay dark and nothing warns you.
 *
 * So this is a tripwire rather than a line in a document. Colour reaches a
 * component through `useTheme().color` and a pure function through a
 * `ThemePalette` parameter — see `constants/theme.ts`.
 */

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "components", "hooks", "lib", "providers", "utils"];
const EXTENSIONS = new Set([".ts", ".tsx"]);

/** `bg-neutral-900`, `text-white`, `ring-green-400/50`, `from-purple-600` … */
const TAILWIND_PALETTE =
  /\b(?:bg|text|border|from|via|to|ring|divide|placeholder|fill|stroke|decoration|outline|caret|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-(?:50|[1-9]00|950))?(?:\/\d{1,3})?\b/;

/**
 * Earned exemptions, each for a stated reason. Not a parking lot: a new entry
 * needs the reason written next to it.
 *
 * - The 10-foot button is its own design (`docs/conventions/tv.md` overrides
 *   the design system on a television) and is driven by D-pad focus rather than
 *   by the palette. It is left exactly as it was.
 * - `TVCardLayouts` holds the white TV focus ring, which is white on every
 *   theme for the same reason.
 */
const ALLOWED = new Set([
  "components/Button.tsx",
  "constants/TVCardLayouts.ts",
]);

const walk = (dir: string, out: string[] = []): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(extname(name)) && !name.includes(".test."))
      out.push(full);
  }
  return out;
};

const sources = SCAN_DIRS.flatMap((dir) => walk(join(ROOT, dir))).map(
  (file) => ({
    path: relative(ROOT, file).split("\\").join("/"),
    text: readFileSync(file, "utf8"),
  }),
);

/** Strip comments, so the files that *explain* this rule do not trip it. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("no hardcoded colours", () => {
  test("the scan actually found the source tree", () => {
    // A glob that matches nothing passes every assertion below for the wrong reason.
    expect(sources.length).toBeGreaterThan(300);
  });

  test("no screen paints itself from Tailwind's own palette", () => {
    const offenders = sources
      .filter(
        (file) =>
          !ALLOWED.has(file.path) && TAILWIND_PALETTE.test(code(file.text)),
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  test("`tokens.color` does not exist, and nothing reaches for it", () => {
    // It was the compatibility shim the migration ran on, pinned to the default
    // theme. Anything still reading it would be silently stuck dark on `light`.
    const offenders = sources
      .filter((file) => /\btokens\s*\.\s*color\b/.test(code(file.text)))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  test("the deleted flat aliases stay deleted", () => {
    // `surface`, `textColor`, `stateColor` and `borderColor` were module
    // constants, so every one of them was one theme's answer.
    const offenders = sources
      .filter((file) =>
        /import\s*\{[^}]*\b(?:surface|textColor|stateColor|borderColor)\b[^}]*\}\s*from\s*"@\/constants\/theme"/.test(
          code(file.text),
        ),
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});
