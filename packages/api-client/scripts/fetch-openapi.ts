#!/usr/bin/env tsx
/**
 * Fetches the StingStream OpenAPI document from a running dev node and writes
 * it to `openapi.json` at the package root, pretty-printed for a clean diff.
 *
 * Usage:
 *   tsx scripts/fetch-openapi.ts [url]
 *   STINGSTREAM_OPENAPI_URL=http://127.0.0.1:8790/stingstream/api/v1/openapi.json tsx scripts/fetch-openapi.ts
 *
 * A dev node must already be running (see docs/RUNNING.md: `cargo run
 * --manifest-path mesh/Cargo.toml -p stingstream -- --dev`). The endpoint is
 * unauthenticated (it is the API's own self-description), so no token is
 * needed here.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = "http://127.0.0.1:8790/stingstream/api/v1/openapi.json";

const url = process.argv[2] ?? process.env.STINGSTREAM_OPENAPI_URL ?? DEFAULT_URL;

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(packageRoot, "openapi.json");

async function main() {
  console.log(`Fetching OpenAPI spec from ${url} ...`);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error(
      `Could not reach ${url}. Is a dev node running? (docs/RUNNING.md: ` +
        `cargo run --manifest-path mesh/Cargo.toml -p stingstream -- --dev)`,
    );
    throw err;
  }
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const spec = await res.json();
  const serialized = `${JSON.stringify(spec, null, 2)}\n`;
  writeFileSync(outPath, serialized, "utf-8");
  console.log(`Wrote ${outPath} (${serialized.length} bytes).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
