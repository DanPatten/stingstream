# @stingstream/api-client

TypeScript client for `/stingstream/api/v1`, generated from the OpenAPI document
`StingStream.Core` publishes at `/stingstream/api/v1/openapi.json` (see `docs/RUNNING.md`
and `docs/ARCHITECTURE.md`). Consumed by `apps/stingstream` (see `docs/UI.md`).

## What's here

| File | What |
|---|---|
| `openapi.json` | Committed snapshot of the live spec. Source of truth for generation; diffed in CI. |
| `src/types.gen.ts` | **Generated, do not edit.** `paths`/`components` types from `openapi.json` via `openapi-typescript`. |
| `src/client.ts` | `createStingStreamClient({ jellyfinBasePath, accessToken })` — a typed [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) client. |
| `src/node-url.ts` | Derives the node's gateway root from the Jellyfin URL the app is already connected to. |
| `scripts/fetch-openapi.ts` | Fetches the spec from a running dev node, overwrites `openapi.json`. |
| `scripts/generate.ts` | Regenerates `src/types.gen.ts` from the committed `openapi.json` (offline, no node needed). |
| `scripts/check.ts` | CI check: fetches the spec from a live node and fails if it differs from what's committed (either the JSON or the generated types). |

## Why there's no separate "node URL"

The app always talks to its own home node's Jellyfin (`docs/ARCHITECTURE.md` — "the app
always talks to its home node's own Jellyfin through this gateway"), and the gateway is a
single port with `/jellyfin/*` and `/stingstream/api/v1/*` as siblings. So the Jellyfin
server URL the app already has (`api.basePath` from `@jellyfin/sdk`, typically
`http://<host>:8790/jellyfin`) *is* the node's address — `getNodeBaseUrl` just strips the
trailing `/jellyfin`. Likewise the same Jellyfin access token authenticates StingStream
API calls, because Core's auth *is* Jellyfin's auth (`Authorization: MediaBrowser
Token="…"`). No second login, no second server-URL setting.

## Regenerating after a server-side API change

Requires a running dev node (`docs/RUNNING.md`):

```powershell
cargo run --manifest-path mesh/Cargo.toml -p stingstream -- --dev
```

Then, from `packages/api-client`:

```powershell
bun install
bun run fetch-openapi   # writes openapi.json from the live node
bun run generate        # writes src/types.gen.ts from openapi.json
git diff openapi.json   # review what changed on the server side before committing
```

`bun run build` (tsc → `dist/`, gitignored) is optional — it's a standalone compile check for this
package, not a step apps/stingstream needs. See "Using it" below for why.

`bun run check` is the CI-friendly version of the same idea: it fetches the live spec and
fails (exit 1) if either `openapi.json` or `src/types.gen.ts` has drifted from what's
committed, without ever overwriting anything — it just tells you regeneration is needed.
Wire it into the same CI job that starts a dev node for other M1/M3 acceptance checks.

## Using it from `apps/stingstream`

```ts
import { createStingStreamClient } from "@stingstream/api-client";
import { useAtomValue } from "jotai";
import { apiAtom } from "@/providers/JellyfinProvider";

const api = useAtomValue(apiAtom);
const client = createStingStreamClient({
  jellyfinBasePath: api?.basePath ?? "",
  accessToken: api?.accessToken,
});

const { data, error } = await client.GET("/status");
```

In practice, use the `useStingStreamClient()` hook in
`apps/stingstream/lib/stingstream/client.ts` instead of building one by hand per call site —
it memoizes the client on the current `api` atom and is what every StingStream screen uses.

`apps/stingstream/package.json` depends on this package as
`"@stingstream/api-client": "file:../../packages/api-client"` (there is no root workspace
manifest in this repo, so `file:` is how bun links it — see `docs/APP-DEV.md`).

**`main`/`types`/`exports` point straight at `src/index.ts`, not a `dist/` build.** The app
consumes this package through Metro/babel, which transforms any resolved module (including
TypeScript) regardless of where it sits — it never reads `dist/`. TypeScript's own `bundler`
module resolution (what `apps/stingstream/tsconfig.json` uses) can likewise resolve a `main`
field straight to a `.ts` file. So a fresh clone typechecks and bundles correctly with **no
build step** for this package — `dist/` was tried first and found the hard way: it's
gitignored, so a clean checkout has no `dist/index.d.ts`, every import from this package
silently resolved to `any`, and dozens of implicit-`any` errors turned up across the app's
settings screens in CI while passing fine locally (where `dist/` happened to already exist).
`bun run build` still exists for anyone who wants a standalone compiled/declared check of this
package in isolation, but nothing depends on its output.
