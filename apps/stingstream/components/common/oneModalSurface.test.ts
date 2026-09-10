import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/**
 * Every modal in the app opens through one component.
 *
 * `components/common/Sheet.tsx` is a `@gorhom/bottom-sheet` on a device and
 * `Sheet.web.tsx` is a centred card in a browser, so a screen never decides the
 * shape of its own modal. This is a test rather than a line in a document
 * because the failure is invisible until someone opens a browser: a panel
 * sliding up from the bottom edge of a 1440 px monitor and spanning the whole
 * window looks like a phone app that got loaded in the wrong place, and every
 * sheet in the app had that bug at once.
 *
 * The scrollables make it worse than cosmetic. `BottomSheetScrollView`,
 * `BottomSheetFlatList` and friends throw "'Scrollable' cannot be used out of
 * the BottomSheet!" when they are not inside a sheet, so one that reaches the
 * web card is a blank page, not a layout nit.
 *
 * Import `SheetModal`, `SheetView`, `SheetScrollView`, `SheetFlatList`,
 * `SheetTextInput`, `SheetBackdrop` from `@/components/common/Sheet`.
 */

const ROOT = process.cwd();
const SCAN_DIRS = [
  "app",
  "components",
  "hooks",
  "lib",
  "providers",
  "utils",
  "services",
];
const EXTENSIONS = new Set([".ts", ".tsx"]);

/**
 * The files allowed to name the package.
 *
 * `Sheet.tsx` is the wrapper itself. The two layouts mount
 * `BottomSheetModalProvider`, which the device half needs at the root and which
 * has no web equivalent to hide behind.
 */
const OWNS_THE_PACKAGE = new Set([
  "components/common/Sheet.tsx",
  "app/_layout.tsx",
  "app/(auth)/now-playing.tsx",
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

/** Strip comments so the files that *explain* this rule do not trip it. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("one modal surface", () => {
  test("the scan actually found the source tree", () => {
    // A glob that matches nothing passes every assertion below for the wrong reason.
    expect(sources.length).toBeGreaterThan(300);
  });

  test("only the wrapper and the layouts import @gorhom/bottom-sheet", () => {
    const offenders = sources
      .filter(
        (file) =>
          !OWNS_THE_PACKAGE.has(file.path) &&
          /from\s+["']@gorhom\/bottom-sheet/.test(code(file.text)),
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  test("the wrapper has a web half", () => {
    const web = sources.find(
      (file) => file.path === "components/common/Sheet.web.tsx",
    );
    expect(web).toBeDefined();
    // The point of the file: React Native's own scrollables, not gorhom's.
    expect(code(web?.text ?? "")).not.toMatch(/@gorhom\/bottom-sheet/);
  });
});
