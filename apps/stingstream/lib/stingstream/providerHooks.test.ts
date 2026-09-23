import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The indexer and download-client hooks hand the server's own sentence to the screen.
 *
 * They used to end in `if (error) throw error`, which throws whatever `openapi-fetch` parsed out of
 * the body: an object or a string, never an `Error`. Every screen reads `err instanceof Error ?
 * err.message : fallback`, so every failure became the fallback, "StingStream could not test it",
 * including the ones where the server had said exactly what was wrong. Dan hit it testing an
 * indexer that passed in Sonarr's own UI.
 *
 * A source check rather than a rendered one, because the bug is one line in a hook and would come
 * back the same way: someone copying a neighbour that still does it the old way.
 */

const source = readFileSync(
  join(process.cwd(), "lib", "stingstream", "hooks.ts"),
  "utf8",
);

/** Every exported hook's body, keyed by name. */
function hooks(): Map<string, string> {
  const out = new Map<string, string>();
  const starts = [...source.matchAll(/^export function (use\w+)\(/gm)];
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : source.length;
    out.set(m[1], source.slice(m.index, end));
  });
  return out;
}

describe("indexer and download-client hooks", () => {
  const touching = [...hooks()].filter(([, body]) =>
    /Settings\/(indexers|downloadclients)/.test(body),
  );

  test("there are some, so the check below is not vacuous", () => {
    expect(touching.length).toBeGreaterThanOrEqual(10);
  });

  test("every one of them goes through unwrap", () => {
    const offenders = touching
      .filter(([, body]) => /throw error/.test(body) || !/unwrap\(/.test(body))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  test("an indexer and a download client can both be edited", () => {
    const names = touching.map(([name]) => name);
    expect(names).toContain("useUpdateIndexer");
    expect(names).toContain("useUpdateExternalDownloadClient");
  });
});
