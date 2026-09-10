import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import {
  buildSettingsCategories,
  flattenCategories,
} from "@/components/shell/buildSettingsCategories";

/**
 * Every settings route draws the category column, or it is a redirect that
 * never paints.
 *
 * The column is a *component*, not a layout route (see `SettingsShell`'s
 * docblock for why), which means every page has to remember to host it and
 * nothing complains when one does not. Six real pages shipped without it: the
 * four plugin drill-ins, `settings/intro` and
 * `settings/appearance/hide-libraries`. Above 1024 px they were a pane with no
 * navigation beside it, so there was no way back to the category they belonged
 * to at all -- not a dead link, no link.
 *
 * A rule nobody can see is a rule that comes back, so it is a test rather than
 * a line in a document -- the same reason `noBrowserDialogs.test.ts` exists,
 * and this file is modelled on it.
 */

const ROOT = process.cwd();
const SETTINGS_DIR = join(ROOT, "app/(auth)/(tabs)/(home)/settings");
/** `/settings` itself: the compact category list, and a redirect when wide. */
const LANDING = join(ROOT, "app/(auth)/(tabs)/(home)/settings.tsx");

const walk = (dir: string, out: string[] = []): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (extname(name) === ".tsx" && !name.includes(".test."))
      out.push(full);
  }
  return out;
};

const routes = [...walk(SETTINGS_DIR), LANDING].map((file) => ({
  path: relative(ROOT, file).split("\\").join("/"),
  text: readFileSync(file, "utf8"),
}));

/** Strip comments, so a file that *explains* the rule does not satisfy it. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const admin: UserDto = {
  Id: "u1",
  Name: "Dan",
  Policy: { IsAdministrator: true } as UserDto["Policy"],
};
/** Keys are echoed back, so an assertion names the key and not a translation. */
const t = (key: string) => key;

describe("every settings route keeps its navigation", () => {
  test("the scan actually found the settings tree", () => {
    // A glob that matches nothing passes every assertion below for the wrong
    // reason.
    expect(routes.length).toBeGreaterThan(25);
  });

  test("a settings route wears the shell, or is a redirect", () => {
    const offenders = routes
      .filter((file) => !/<Redirect\b/.test(code(file.text)))
      .filter((file) => !/<Settings(Shell|Page)\b/.test(code(file.text)))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  test("the admin gate goes inside the column, never around it", () => {
    // `SettingsPage`'s rule: a pasted URL for a category a member cannot open
    // should still show them the settings they can, with the refusal in the
    // pane. `export default adminOnly(Page)` puts the refusal where the column
    // should have been, so a member loses the whole of Settings rather than the
    // one page. Use `<RequiresAdmin>` inside the shell, as `servers/join` does.
    const offenders = routes
      .filter((file) => /\badminOnly\b/.test(code(file.text)))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  test("every categoryKey names a real category", () => {
    // Catches a key that names a *group* rather than a category -- `downloading`
    // is both -- or one that outlived the category it was written for. Either
    // way the page draws a column with no row lit and nothing reports it.
    const keys = new Set(
      flattenCategories(buildSettingsCategories(admin, t)).map(
        (category) => category.key,
      ),
    );
    const declared = routes.flatMap((file) =>
      [...file.text.matchAll(/categoryKey=['"]([^'"]+)['"]/g)].map((match) => ({
        path: file.path,
        key: match[1],
      })),
    );

    expect(declared.length).toBeGreaterThan(15);
    expect(declared.filter((entry) => !keys.has(entry.key ?? ""))).toEqual([]);
  });
});
