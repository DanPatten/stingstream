import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/**
 * The app never asks a question with the browser's own dialog.
 *
 * Dan: *"NEVER use browser's alert function - replace them with proper modals - remmeber this
 * going forward"*. A rule nobody can see is a rule that comes back, so it is a test rather than a
 * line in a document: `confirmDestructive` was itself written as a `globalThis.confirm` wrapper,
 * and the reason that looked reasonable at the time is exactly why this needs a tripwire.
 *
 * Two things are banned, for two different reasons:
 *
 * - **`globalThis.confirm` / `alert` / `prompt`** — unstyleable, prefixed with the page's
 *   hostname, blocks the JS thread, and most browsers offer "prevent this page from creating more
 *   dialogs", which silently turns every later confirmation into an automatic no.
 * - **`Alert.alert` outside television** — react-native-web draws *nothing at all* for it, so a
 *   guarded destructive action on the web bundle just does nothing when pressed.
 *
 * Use `confirmDestructive` / `confirmAction` from
 * `components/stingstream/shared/confirm.ts` for a question, and `toast` for a statement.
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
 * Television keeps `Alert.alert`, and that is the point rather than an exemption: there it is a
 * real native control a remote can drive, and `docs/conventions/tv.md` rules out the overlay kind
 * of modal on that platform outright. A file earns its place here by being TV-only.
 */
const TV_ONLY =
  /(\.tv\.tsx?$)|(\/TV[A-Z])|(useTVItemActionModal)|(settings\.tv)/;

/** The two helpers that own the TV branch on everybody else's behalf. */
const OWNS_THE_TV_BRANCH = new Set([
  "components/stingstream/shared/confirm.ts",
  "hooks/useConfirmDelete.ts",
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

/** Strip comments so the many files that *explain* this rule do not trip it. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("no browser dialogs", () => {
  test("the scan actually found the source tree", () => {
    // A glob that matches nothing passes every assertion below for the wrong reason.
    expect(sources.length).toBeGreaterThan(300);
  });

  test("nothing calls the browser's alert, confirm or prompt", () => {
    const offenders = sources
      .filter((file) =>
        /\b(globalThis|window)\s*\.\s*(alert|confirm|prompt)\s*\??\.?\(/.test(
          code(file.text),
        ),
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  test("Alert.alert is confined to television", () => {
    const offenders = sources
      .filter(
        (file) =>
          !TV_ONLY.test(file.path) &&
          !OWNS_THE_TV_BRANCH.has(file.path) &&
          /\bAlert\s*\.\s*alert\s*\(/.test(code(file.text)),
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});
