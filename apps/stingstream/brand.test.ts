import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// Zero user-visible "Jellyfin", "Streamyfin", "Radarr", "Sonarr", "NZBGet" or "Emby" — the v0.2.0
// rebrand decision (plan-an-app-by-cozy-hearth.md, Part 2, Decisions: "Upstream names"). Modelled
// on assets/bundled-assets.test.ts: pin what should be true, name every known exception, and fail
// the moment an exception stops being true so the allowlist can only shrink.
//
// "Jellyseerr" and "Seerr" are a different product (kept, and not covered by this guard) —
// the word-boundary regex below does not match them.

const root = __dirname;
const BRAND_RE = /\b(Jellyfin|Streamyfin|Radarr|Sonarr|NZBGet|Emby)\b/i;

// ---------------------------------------------------------------------------
// (1) translations/*.json — no value may name an upstream product.
// ---------------------------------------------------------------------------

type LocaleTree = { [key: string]: LocaleTree | string };

function localeViolations(
  tree: LocaleTree,
  path: string,
  file: string,
): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const at = path ? `${path}.${key}` : key;
    if (typeof value === "string") {
      if (BRAND_RE.test(value))
        found.push(`${file}:${at} = ${JSON.stringify(value)}`);
    } else if (value && typeof value === "object") {
      found.push(...localeViolations(value, at, file));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// (2) app/**, components/**, providers/**, hooks/**, utils/**, lib/** — no string literal,
// template literal or JSX text node may contain a brand word AND a space, unless the exact
// (file, substring) pair is allow-listed with a reason. A bare identifier-shaped literal (an
// enum value, a query-key segment, an API path, a picker label like "NZBGet") has no space and
// so is never flagged — that is deliberate: those are internal identifiers or genuine third-party
// names, not prose. Parsed with the TypeScript compiler's own AST rather than regex, because a
// naive quote/backtick scan misreads a nested template literal (backticks inside a `${...}`
// span) as spanning to the next unrelated backtick in the file — verified against this exact
// codebase while building this test.
const SCAN_DIRS = ["app", "components", "providers", "hooks", "utils", "lib"];
const EXCLUDE_PREFIXES = ["utils/jellyseerr/"];

interface AllowlistEntry {
  file: string;
  substring: string;
  reason: string;
}

const allowlist: AllowlistEntry[] = JSON.parse(
  readFileSync(join(root, "scripts/brand-allowlist.json"), "utf8"),
);

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules") continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function scanCodeForBrandWords(): Hit[] {
  const files = SCAN_DIRS.flatMap((dir) => sourceFiles(join(root, dir))).filter(
    (full) => {
      const rel = relative(root, full).replace(/\\/g, "/");
      return !EXCLUDE_PREFIXES.some((prefix) => rel.startsWith(prefix));
    },
  );

  const hits: Hit[] = [];
  for (const full of files) {
    const text = readFileSync(full, "utf8");
    const rel = relative(root, full).replace(/\\/g, "/");
    const sourceFile = ts.createSourceFile(
      full,
      text,
      ts.ScriptTarget.Latest,
      true,
      full.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const record = (node: ts.Node, value: string) => {
      // "and a space": distinguishes prose (what a user reads) from a bare
      // identifier-shaped literal (an enum value, a query key, an API path segment,
      // a third-party picker label) — see the block comment above.
      if (BRAND_RE.test(value) && /\s/.test(value)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        hits.push({ file: rel, line: line + 1, text: value.trim() });
      }
    };

    const visit = (node: ts.Node) => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        record(node, node.text);
      } else if (ts.isTemplateExpression(node)) {
        record(node.head, node.head.text);
        for (const span of node.templateSpans)
          record(span.literal, span.literal.text);
      } else if (ts.isJsxText(node)) {
        record(node, node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return hits;
}

// ---------------------------------------------------------------------------

// Computed once at module scope, like bundled-assets.test.ts's `requiredAssets` — the AST parse
// of every scanned file is the expensive part, and each of the four tests below needs the same
// result; re-running it per test risks the suite's default per-test timeout under load.
const hits = scanCodeForBrandWords();

describe("brand guard: zero user-visible upstream names", () => {
  test("the scan finds the offenders it is meant to guard against", () => {
    // Fixture check, mirroring bundled-assets.test.ts's pattern: if this ever stops finding
    // anything, the scan itself broke, not the codebase — the same failure mode a silently
    // empty allowlist would hide.
    expect(hits.some((h) => h.file === "providers/JellyfinProvider.tsx")).toBe(
      true,
    );
  });

  test("no translations/*.json value names an upstream product", () => {
    const translationsDir = join(root, "translations");
    const files = readdirSync(translationsDir).filter((f) =>
      f.endsWith(".json"),
    );
    const violations = files.flatMap((file) =>
      localeViolations(
        JSON.parse(readFileSync(join(translationsDir, file), "utf8")),
        "",
        file,
      ),
    );
    // A non-empty list here names the translations/*.json keys to reword. "Jellyseerr"/"Seerr"
    // are a different product and do not match.
    expect(violations).toEqual([]);
  });

  test("no un-allowlisted brand word survives in app/components/providers/hooks/utils/lib", () => {
    const unlisted = hits.filter(
      (h) =>
        !allowlist.some(
          (e) => e.file === h.file && h.text.includes(e.substring),
        ),
    );
    // A non-empty list here names real offenders: either fix the string, or add a
    // {file, substring, reason} entry to scripts/brand-allowlist.json if it is a genuine
    // exception (an internal diagnostic, or a real fact about an upstream API).
    expect(unlisted.map((h) => `${h.file}:${h.line}  ${h.text}`)).toEqual([]);
  });

  test("every allowlist entry still matches something (the list only shrinks)", () => {
    const stale = allowlist.filter(
      (e) =>
        !hits.some((h) => h.file === e.file && h.text.includes(e.substring)),
    );
    // A non-empty list here names allowlist entries whose code has since changed (fixed, moved
    // or reworded) — remove them from scripts/brand-allowlist.json rather than leaving dead
    // exceptions behind.
    expect(stale.map((e) => `${e.file}: ${e.substring}`)).toEqual([]);
  });

  test("app.json is StingStream's own", () => {
    const appJson = JSON.parse(readFileSync(join(root, "app.json"), "utf8"));
    expect(appJson.expo.scheme).toBe("stingstream");
    expect(appJson.expo.name).toBe("StingStream");
    expect(appJson.expo.web.name).toBe("StingStream");
  });
});
