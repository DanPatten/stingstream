# M2 — Unified UI v1

How the StingStream screens are built, what talks to what, and how to add another one. Companion
to `docs/RUNNING.md` (how a node runs) and `docs/M2-web-spike.md` (why the web target works the
way it does). `docs/UI-API-GAPS.md` lists what these screens want that the server doesn't expose
yet.

---

## Screen map

| Screen | Where | Visible on | Admin only? |
|---|---|---|---|
| Manage (Movies/Series/Calendar/Activity) | new tab `(manage)` | phone, web | yes |
| Downloads | new tab `(downloads)` | phone, web | yes |
| Server settings | Settings → Server settings | phone, web | yes |
| Admin | Settings → Admin | phone, web | yes |
| Node status | Settings → Node status | phone, web | yes |

All five are hidden on TV (`tabBarItemHidden: Platform.isTV` on the two tabs; the `settings.tsx`
entries only render inside the phone/web `SettingsMobile` branch, never `settings.tv.tsx`) — TV
keeps the existing browse/play/requests surface untouched, per the M2 brief. All five are also
gated behind `user?.Policy?.IsAdministrator` (`components/stingstream/shared/RequiresAdmin.tsx`),
because every `StingStream.Core` endpoint requires Jellyfin's `RequiresElevation` policy (see any
operation's `security` block in `packages/api-client/openapi.json`) — there is no non-admin use for
these screens today. Group and Requests are out of scope for M2 (M3/M6 respectively, per
`docs/ARCHITECTURE.md`).

### Where the route files live

Expo Router's route groups (parenthesised segments) don't appear in the URL, so these physical
paths collapse the way the table below shows:

```
apps/stingstream/app/(auth)/(tabs)/(manage)/_layout.tsx     Stack wrapper, header "Manage"
apps/stingstream/app/(auth)/(tabs)/(manage)/index.tsx       segmented Movies/Series/Calendar/Activity

apps/stingstream/app/(auth)/(tabs)/(downloads)/_layout.tsx
apps/stingstream/app/(auth)/(tabs)/(downloads)/index.tsx

apps/stingstream/app/(auth)/(tabs)/(home)/settings/server/page.tsx   -> /settings/server/page
apps/stingstream/app/(auth)/(tabs)/(home)/settings/admin/page.tsx    -> /settings/admin/page
apps/stingstream/app/(auth)/(tabs)/(home)/settings/node/page.tsx     -> /settings/node/page
```

The last three follow the exact convention every other settings sub-page already uses (e.g.
`settings/network/page.tsx` → `/settings/network/page`) — a plain file-system route, reached with
`router.push("/settings/server/page")`, registered in `(home)/_layout.tsx`'s `<Stack>` with its own
`options={{ title: ... }}` for a real header (expo-router renders unregistered nested routes fine,
but without an explicit `<Stack.Screen>` entry they inherit a blank title).

### Why two new tabs instead of only settings sub-pages

Manage and Downloads are primary, frequently-used screens (the plan's own wording: "Manage:
Movies and Series tabs", "Downloads: unified view...") — they got their own bottom-tab route
groups, built the same way the existing `(favorites)` tab is (a `_layout.tsx` `<Stack>` + an
`index.tsx`). Server settings, Admin and Node status are occasional/administrative, so they hang
off the existing Settings screen instead of consuming two more tab slots — consistent with how
Streamyfin's own settings sub-pages (network, logs, plugins, ...) are organized.

### Shared files touched (additive only, per this milestone's path ownership)

- `app/(auth)/(tabs)/_layout.tsx` — two new `<NativeTabs.Screen>` entries (Manage, Downloads).
- `app/(auth)/(tabs)/(home)/_layout.tsx` — three new `<Stack.Screen>` entries for the settings
  sub-pages' headers.
- `app/(auth)/(tabs)/(home)/settings.tsx` — one new `ListGroup` ("StingStream node") linking to the
  three settings sub-pages, rendered only for administrators.

No existing screen's behavior changed; every edit above is a new block appended to an existing
list.

---

## How data flows

```
Screen (app/**)
   │  react-query hook
   ▼
lib/stingstream/hooks.ts  ──uses──▶  lib/stingstream/client.ts (useStingStreamClient)
   │                                     │
   │                                     ▼
   │                            @stingstream/api-client (createStingStreamClient)
   │                                     │  openapi-fetch, typed from packages/api-client/src/types.gen.ts
   │                                     ▼
   │                       http://<node>:8790/stingstream/api/v1/*   (StingStream.Core, inside Jellyfin)
   │
   └─ Admin screens instead call @jellyfin/sdk directly (getUserApi, getLibraryApi,
      getLibraryStructureApi, getConfigurationApi, getSystemApi) against the SAME `apiAtom` the rest
      of the app already uses — these are genuine Jellyfin admin features (users, libraries,
      transcoding, logs), not StingStream.Core's business, so they go through `/jellyfin/*` like
      every other Jellyfin call the app makes.

lib/stingstream/status.ts — plain `fetch` against `/healthz` only. It is a gateway-level
endpoint, not part of Core's own OpenAPI document, so it's outside the generated client; see
the file's own comment.
```

**The gateway's raw `/stingstream/mesh/*` is loopback-only by design (M3b) — never call it from
the app.** It's the mesh child's own unauthenticated port, proxied through the gateway; it can
create groups and mint invite codes with no auth of its own, and the gateway binds `0.0.0.0`, so
routing it to the LAN would hand any device on the network the ability to do that. Every mesh
operation the app needs (status, groups, join, invite, index, peers) has an authenticated
equivalent under `/stingstream/api/v1/mesh/*` in Core's own OpenAPI document — reachable through
the generated client exactly like every other StingStream endpoint (`useMeshStatus()` in
`lib/stingstream/hooks.ts` is the example this milestone's Node status screen uses). Those
endpoints answer `503` (not an empty result) when the mesh can't be reached — deliberately, since
the federated-library materializer reads an empty group index as "this group holds nothing" and
would delete every pointer file on a mesh restart otherwise. Treat `503` here as "mesh
unavailable / still starting," not as "empty" — the two look identical if a screen only inspects
the response body instead of the status.

**Auth.** `useStingStreamClient()` (`lib/stingstream/client.ts`) reads the app's existing
`apiAtom` (the same `@jellyfin/sdk` `Api` object every Jellyfin screen uses) and builds a client
from `api.basePath` and `api.accessToken` — no second login, no separate "node URL" setting. See
`packages/api-client/README.md` ("Why there's no separate node URL") for the full reasoning:
Core's auth *is* Jellyfin's auth, and the gateway serves `/jellyfin/*` and
`/stingstream/api/v1/*` as siblings on the same port, so the Jellyfin URL the app is already
connected to (typically `http://<host>:8790/jellyfin`) is the node's address minus one path
segment.

**Types.** `packages/api-client/src/types.gen.ts` is generated from
`packages/api-client/openapi.json` (a committed snapshot of `/stingstream/api/v1/openapi.json`).
Regenerating after a server-side API change: see `packages/api-client/README.md`. Two endpoints
(`GET /movies`, `GET /series`) have no response schema in Core's own OpenAPI — Core passes
Radarr's/Sonarr's JSON straight through, so their real shape is hand-typed (loosely) in
`lib/stingstream/arr-types.ts` rather than generated.

**Loading / empty / error / refresh.** Every screen uses the same small set of primitives in
`components/stingstream/shared/`:
- `QueryState` — renders `LoadingState` / `ErrorState` (with a retry) / children, from a
  react-query result.
- `EmptyState` — "nothing here yet" with an optional detail line.
- `GapNotice` — "this isn't available yet" for a feature with no server endpoint (see
  `docs/UI-API-GAPS.md`); deliberately distinct from `EmptyState` so a genuine empty list ("no
  movies yet") never looks the same as a missing API.
- `RefreshScreen` — the `ScrollView` + `RefreshControl` + safe-area scaffold every screen renders
  its content inside, wired to a screen-local `onRefresh` that invalidates the `["stingstream"]`
  react-query prefix (or, for Admin, the `["stingstream", "jellyfin-*"]` prefix).
- `SegmentedControl` / `SegmentedControlBar` — the pill-button row Manage, Server settings and
  Admin all use to switch sections. Deliberately local `useState`, not a nested router stack or
  `@react-navigation/material-top-tabs`: these are flat, same-depth sections of one screen, not
  independently deep-linkable pages.
- `RequiresAdmin` — the admin gate described above.

---

## What's live vs. stubbed (short version — `docs/UI-API-GAPS.md` has the full detail)

| Area | Live | Stubbed (gap notice, no fake data) |
|---|---|---|
| Manage → Movies/Series | list, add by TMDB/TVDB id | title search, monitor toggle, delete, per-item quality-profile edit |
| Manage → Calendar | — | everything (no server data at all) |
| Manage → Activity | Queue (both apps) | History |
| Downloads | aggregate engine health (torrent engine + NZBGet + hashing queue, from `/status` and `/healthz`) | per-item list, pause/resume/remove |
| Server settings → Indexers | full CRUD | connectivity test |
| Server settings → Download clients | embedded-engine toggles, DHT, categories, housekeeping | adding an external client |
| Server settings → Quality profiles | default-profile-name field | listing/creating/editing actual profiles |
| Server settings → Root folders / Naming / Notifications (incl. extra webhooks) | full CRUD | — |
| Admin → Users / Libraries / Transcoding / Logs | all of it (Jellyfin's own API) | — |
| Node status | `/healthz` children, node info, gateway port; `/status` (Core); `/stingstream/api/v1/mesh/status` (mesh identity, addresses, group count); side door candidates + a live per-candidate reachability/DNS-rebinding test (M5, `components/stingstream/node/SideDoorSection.tsx`, `docs/APP-RELEASE.md` §8) | per-child version numbers |

A stubbed feature never shows fabricated rows presented as real data — it shows `GapNotice` with a
one-line reason and a pointer to `docs/UI-API-GAPS.md`. The one partial exception is Manage's add
forms, which are fully functional (add by id) with a small note that title search specifically
isn't wired up yet.

---

## Web bundle

```powershell
cd apps/stingstream
bun run build:web        # -> apps/stingstream/dist  (thin wrapper around `expo export --platform web`)
```

Output is a single SPA bundle (`output: "single"` in `app.json`; `dist/` is gitignored) — see
`docs/M2-web-spike.md` §7 for why static per-route rendering wasn't used. The gateway
(`mesh/crates/stingstream`, M3b's territory) serves this at `/`; for local verification without a
built gateway, serve `dist/` with any static file server and point it at a dev node's port:

```powershell
npx serve apps/stingstream/dist -l 5173
# then open http://127.0.0.1:5173 and connect to http://127.0.0.1:8790/jellyfin as the server
```

---

## Developing against a node without colliding with a server-side rebuild

**The problem.** `cargo run -p stingstream -- --dev` and `dotnet build .../Jellyfin.Server.csproj`
both run their binaries straight out of the repo's own build output
(`mesh/target/debug/stingstream.exe`, `server/jellyfin/.../bin/Debug/net10.0/*.dll`). Several agents
build and run in this repo at once (see the global CLAUDE.md rule about shared working trees), so a
node you left running for UI verification holds those files open — a concurrent
`dotnet build`/`cargo build` by someone touching `server/**` or `mesh/**` then fails outright
(`MSB3027`/a locked-file error on Windows, since a DLL that is loaded cannot be overwritten).

**The fix: run your verification node from a private copy of the build output, not the in-repo
paths.** `--install-root <DIR>` (see `docs/RUNNING.md`) makes the supervisor look for children
under `<DIR>/bin/<child>/` instead of the repo's own `target`/`bin` directories, which is exactly
what a production install does — so this is also good practice for verification, not just a
workaround.

**Confirmed working layout** (verified against `mesh/crates/stingstream/src/supervisor/childdef.rs`
and by actually running a node this way during M2's own verification — `resolve_prod_dotnet` looks
for a child's entry point *directly* inside `<install>/bin/<child>/`, not one directory level
deeper, and `Mode::Prod` has no repo-root fallback at all, so ffmpeg/nzbget need copying too, not
just jellyfin/radarr/sonarr):

```powershell
# One-time (or after a fresh server-side change lands): stage a private copy.
$bin = "E:\Dan\Documents\Repos\.win-temp\stingstream-m2-bin"
New-Item -ItemType Directory -Force `
  "$bin\bin\jellyfin", "$bin\bin\radarr", "$bin\bin\sonarr", `
  "$bin\bin\ffmpeg\win64", "$bin\bin\nzbget\win64", "$bin\bin\mesh" | Out-Null

Copy-Item "mesh\target\debug\stingstream.exe" "$bin\stingstream.exe" -Force
# Optional: only read if [mesh] embedded = false is set. Default is embedded (M3b), so a node
# normally needs no separate mesh binary at all.
Copy-Item "mesh\target\debug\stingstream-mesh.exe" "$bin\bin\mesh\" -Force -ErrorAction SilentlyContinue

Copy-Item "server\jellyfin\Jellyfin.Server\bin\Debug\net10.0\*" "$bin\bin\jellyfin\" -Recurse -Force
Copy-Item "server\radarr\_output\net8.0\*" "$bin\bin\radarr\" -Recurse -Force
Copy-Item "server\sonarr\_output\net10.0\*" "$bin\bin\sonarr\" -Recurse -Force
Copy-Item "third_party\ffmpeg\bin\win64\*" "$bin\bin\ffmpeg\win64\" -Recurse -Force
Copy-Item "third_party\nzbget\bin\win64\*" "$bin\bin\nzbget\win64\" -Recurse -Force

# Run from the copy — no locks on anything under mesh/ or server/. --web-dist is needed here
# because the "look in apps/stingstream/dist automatically" default only applies in --dev; Prod
# mode (which --install-root selects) has no repo root to derive it from.
& "$bin\stingstream.exe" --install-root $bin `
  --data-dir "E:\Dan\Documents\Repos\.win-temp\stingstream-m2-dev" `
  --web-dist "apps\stingstream\dist"
```

Re-run the `Copy-Item` block after any fresh server-side rebuild you want to pick up (each run is a
few seconds — copying, not rebuilding). **Stop your node** (Ctrl+C, or find-and-kill
`stingstream.exe` and its children by PID — see "Known limitations" in `docs/RUNNING.md` re: Windows
having no graceful child stop) before anyone else needs to rebuild `mesh/**` or `server/**`, and say
so out loud (a one-line message to whoever's waiting) rather than assuming they'll notice.

---

## How to add a screen

1. Decide: does it need its own tab (primary, frequent — like Manage/Downloads), or a settings
   sub-page (occasional/admin — like Server settings/Admin/Node status)? Follow the file-placement
   pattern in "Where the route files live" above.
2. If it needs data from `StingStream.Core`: check `packages/api-client/openapi.json` first (or
   regenerate against a running dev node, see the package's README). If the endpoint exists, add a
   hook to `lib/stingstream/hooks.ts` following the existing pattern (react-query, `enabled: !!client`,
   invalidate the right query keys on mutation). If it doesn't, add a `GapNotice` and a new entry in
   `docs/UI-API-GAPS.md` — don't fake the data.
3. If it needs Jellyfin admin data (users, libraries, system config, logs): use
   `@jellyfin/sdk/lib/utils/api` directly against the existing `apiAtom`, the way
   `components/stingstream/admin/*` does — this is not StingStream.Core's job.
4. Build the screen from `components/stingstream/shared/*` (`RefreshScreen`, `QueryState`,
   `EmptyState`, `GapNotice`, `SegmentedControl*`) plus the app's existing design-system components
   (`components/list/ListGroup`, `components/list/ListItem`, `components/common/Text`,
   `components/common/SettingSwitch`, `Colors` from `constants/Colors`) — no new visual language.
5. Gate it behind `RequiresAdmin` if it talks to any `RequiresElevation` endpoint (check the
   operation's `security` block in the OpenAPI doc) or to a Jellyfin admin-only API.
6. Hide it on TV if it's a management screen: `tabBarItemHidden: Platform.isTV` for a new tab, or
   simply don't add it to `settings.tv.tsx` for a settings sub-page.
7. Run `bun run typecheck` and `./node_modules/.bin/biome check --write --unsafe <paths>` before
   committing — both are fast and catch real bugs (an earlier pass of this exact work caught two
   `possibly undefined` errors this way).
