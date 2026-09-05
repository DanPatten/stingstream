#!/usr/bin/env tsx
/**
 * CI check: does the committed `openapi.json` snapshot (and the
 * `src/types.gen.ts` generated from it) still match what a live dev node
 * actually serves?
 *
 * Fetches the spec fresh from a running dev node, regenerates the types in
 * memory, and compares both against what's committed. Fails with a clear
 * message (and exit code 1) on any drift — the fix is always the same:
 *
 *   pwsh tools/... start a dev node (docs/RUNNING.md)
 *   bun run fetch-openapi
 *   bun run generate
 *   git add openapi.json src/types.gen.ts && commit
 *
 * Usage:
 *   tsx scripts/check.ts [url]
 *   STINGSTREAM_OPENAPI_URL=... tsx scripts/check.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";
import { dedupeOperationIds } from "./prepare-spec";

const DEFAULT_URL = "http://127.0.0.1:8790/stingstream/api/v1/openapi.json";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(packageRoot, "openapi.json");
const typesPath = join(packageRoot, "src", "types.gen.ts");

function normalize(json: unknown): string {
  return `${JSON.stringify(json, null, 2)}\n`;
}

async function main() {
  const url =
    process.argv[2] ?? process.env.STINGSTREAM_OPENAPI_URL ?? DEFAULT_URL;

  console.log(`Fetching live OpenAPI spec from ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const liveSpec = await res.json();
  const liveSerialized = normalize(liveSpec);

  const committedSerialized = readFileSync(specPath, "utf-8");

  let failed = false;

  if (liveSerialized !== committedSerialized) {
    failed = true;
    console.error(
      "openapi.json is out of date: the live node's spec differs from the " +
        "committed snapshot.\n  Fix: bun run fetch-openapi && bun run generate, then commit both files.",
    );
  }

  const ast = await openapiTS(dedupeOperationIds(structuredClone(liveSpec)), {
    exportType: false,
  });
  const liveTypesBody = astToString(ast);
  const committedTypes = readFileSync(typesPath, "utf-8");
  // The committed file carries a header the generator also writes; compare
  // only the generated body so header wording changes don't false-positive.
  const committedBody = committedTypes.split("\n").slice(4).join("\n");

  if (liveTypesBody.trim() !== committedBody.trim()) {
    failed = true;
    console.error(
      "src/types.gen.ts is out of date relative to the live node's spec.\n" +
        "  Fix: bun run fetch-openapi && bun run generate, then commit both files.",
    );
  }

  if (failed) {
    process.exit(1);
  }
  console.log("OK: committed openapi.json and src/types.gen.ts match the live node.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
