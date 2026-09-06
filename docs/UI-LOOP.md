# The UI iterate loop (WP-TOOLS)

Tooling for v0.2.0's "iterate loop" (the plan's Part 2, section "The iterate loop"): run a private
StingStream node, seed it with deterministic test media carrying real TMDB/TVDB movie artwork by
default (F-12, Dan: "tests must use real movie images, never placeholders" -- offline gradients
are opt-in, see `-OfflineArtwork` below), screenshot every screen at every viewport, sweep each one
for real problems, and drive the golden-startup budgets end to end. All of
it lives under `tools/ui-node.ps1`, `tools/ui-seed-media.ps1`, `tools/ui-startup.ps1` and
`tools/ui-shots/**`. This package owns those files and this document; it does not own any
`apps/stingstream/**` source file -- every screen this loop screenshots belongs to another work
package, and the `testID` contract below is a request to those packages, not something this
package implements.

Companion documents: `docs/RUNNING.md` (what a node is and how `config.toml`/`runtime.json` work),
`docs/CONTRIBUTING.md` (rule 3: never run a node out of the repository's own build outputs),
`docs/UI.md` (how the app's own screens are organised).

---

## Tier A vs Tier B

**Tier A** -- edit, see it in seconds, never reviewed. Start a node with `-DevServer` pointed at a
running `bunx expo start --web --port 8081` (from `apps/stingstream`; never `bun run start`, which
runs `git submodule update`), then open the node's own URL, e.g. `http://127.0.0.1:8795/`. The
gateway proxies `/` and the SPA fallback through to Metro (WP-GATE's `--web-dev-server` flag), so
the browser only ever talks to one origin. **Same-origin is mandatory, not a convenience**: Jellyfin's
`CorsHosts` is deliberately empty and the gateway adds no CORS headers of its own, so a browser
pointed directly at Metro on `8081` can load the app shell but every `/jellyfin/*` and
`/stingstream/api/v1/*` call fails outright. Do not widen `CorsHosts` to work around this -- proxy
through the gateway instead, which is what `-DevServer` is for.

**Tier B** -- what ships, and what every screenshot in `tools/ui-shots` is taken against. Export the
app (`bunx expo export --platform web --output-dir <dir>`, roughly 30-60s warm) and start a node
with `-WebDist <dir>`. Screenshots, sweeps and the golden-startup budgets are all Tier B by default;
Tier A is for the fast loop between passes, not for anything a report cites.

**Never write to `apps/stingstream/dist`** (the shared, gitignored export other agents may also be
using) **and never run a node out of `mesh/target/debug/`or `server/*/bin/` directly** -- both are
`docs/CONTRIBUTING.md` rule 3. Everything in this package runs from a private copy under
`E:\Dan\Documents\Repos\.win-temp\ui-loop\`:

```
.win-temp\ui-loop\
  bin\            tools/ui-node.ps1's private install-root copy (supervisor, Jellyfin, optionally the arrs)
  data\           the default node's data directory (config.toml, runtime.json, media, logs)
  web-dist\       default Tier B export target (tools/ui-node.ps1's -WebDist default)
  startup\        tools/ui-startup.ps1's own private data dir + logs + shots
  apk\<variant>\  APKs copied out by tools/ui-shots/android.ps1 -Build
  pass-NN\        one folder per review pass: web/, phone/, tv/, report.md, review.md
```

---

## Commands

```powershell
# Start a private node: Jellyfin + mesh only (no arrs), seeded, fresh data dir, Tier B if a
# web-dist export already exists at the default location.
powershell tools\ui-node.ps1 -Fresh -Seed

# Point it at a running Metro dev server instead (Tier A).
powershell tools\ui-node.ps1 -DevServer http://127.0.0.1:8081

# Full node (Radarr/Sonarr/NZBGet too), bound to loopback only.
powershell tools\ui-node.ps1 -Fresh -Seed -WithArrs -Bind 127.0.0.1

# Stop whatever is running against the default data dir.
powershell tools\ui-node.ps1 -Stop

# Seed media into an already-running node's data dir (also usable standalone).
powershell tools\ui-seed-media.ps1 -MediaRoot E:\Dan\Documents\Repos\.win-temp\ui-loop\data\media

# Screenshots + sweep + report, three viewports, against a running node.
cd tools\ui-shots
node shots.mjs --base http://127.0.0.1:8795 --out ..\..\..\.win-temp\ui-loop\pass-00\web `
  --pass-file ..\..\..\.win-temp\ui-loop\data\runtime.json

# One screen, all viewports, while iterating on it.
node shots.mjs --base http://127.0.0.1:8795 --out <dir> --pass-file <runtime.json> --only 02-home

# The golden-startup acceptance run.
powershell tools\ui-startup.ps1 -WebDist E:\Dan\Documents\Repos\.win-temp\ui-loop\web-dist -DriveUi -Lan

# Android phone: start the emulator, install the current debug APK, capture a screen.
powershell tools\ui-shots\android.ps1 -Emulator start -Variant phone
adb install -r apps\stingstream\android\app\build\outputs\apk\debug\app-debug.apk
powershell tools\ui-shots\android.ps1 -Capture phone
```

`tools/ui-shots` has its own `package.json`/lockfile and runs with plain `node` -- never `bun`, and
never installed into `apps/stingstream`. One-time setup:

```powershell
cd tools\ui-shots
npm install       # also runs `playwright install chromium` via postinstall
```

---

## `tools/ui-node.ps1`

Params: `-PrivateCopy` (default `...\ui-loop\bin`), `-DataDir` (default `...\ui-loop\data`),
`-Fresh` (stop anything running against that data dir, wipe it), `-ForceCopy` (refresh the private
copy from the current build outputs -- run this after any `cargo build`/`dotnet build` you want
reflected), `-Port` (default 8795), `-WithArrs` (switch, default off: `[children]
radarr/sonarr/nzbget = false`, the same shape `tools/e2e-m4.ps1` uses for a pure holder), `-Bind`
(`0.0.0.0` default so a LAN IP and an Android emulator's `10.0.2.2` both work; `127.0.0.1` to
restrict to this machine), `-WebDist <dir>`, `-DevServer <url>` (passes `--web-dev-server <url>` --
see "The `--web-dev-server` flag" below), `-Seed` (runs `ui-seed-media.ps1` into the data dir's
media root **before** the node's first start, so the first library scan finds the files already
there -- confirmed to matter, see "Does first-run wiring scan pre-placed files?" below; real
TMDB/TVDB artwork by default, F-12 -- see "Real artwork by default" below), `-OfflineArtwork`
(with `-Seed`: fall back to the old offline gradients instead), `-Stop`.

`config.toml` is written once (first start only, matching the supervisor's own "written with
defaults, never rewritten" contract for this file -- delete it, or pass `-Fresh`, to regenerate):
every child port `0` (pick an ephemeral one) except the gateway itself, debug logging, console
logging on, `[sidedoor] enabled = false` (no coordinator in this loop, so the side door has nothing
to serve -- `docs/RUNNING.md` -- and disabling it outright keeps every start a little faster).
Prints the gateway/health/API/Jellyfin URLs, the LAN URL and the Android-emulator URL
(`http://10.0.2.2:<port>`) when bound to `0.0.0.0`, and once `runtime.json`'s first-run wiring
clears, "admin credentials are in `<DataDir>\runtime.json`" -- **never the password itself**. Every
script in this package follows the same rule: the generated admin password is read from
`runtime.json` where it is needed and never appears in stdout, a log file, a screenshot, a commit,
or (for the Node/Playwright side) a process command-line argument -- see
`tools/ui-shots/lib/authFile.mjs`, which every script that needs to sign in imports rather than
handling the password itself. `--pass-file <path to runtime.json>` is the CLI shape used
everywhere a password is needed; there is no `--pass` flag anywhere in this package, on purpose.

### The `--web-dev-server` flag

WP-GATE is landing `--web-dev-server` (and the matching `gateway.web_dev_server` config key) in
parallel with this package. Until it lands, the flag does not exist yet and the supervisor's own
`clap` argument parser rejects it immediately (exit code, not a hang) with an "unexpected
argument"/"unrecognized" message on stderr. `-DevServer` tries the flag, detects that specific
rejection, prints a warning, and restarts the node without it (falling back to whatever `-WebDist`
resolves to, or the placeholder page) rather than failing the whole script. Once WP-GATE lands the
flag this fallback simply never triggers again -- nothing to update here.

### Does first-run wiring scan pre-placed files?

**Yes, confirmed live (2026-09-06).** Media placed on disk under `<DataDir>\media\Movies` and
`<DataDir>\media\TV` *before* the node's first start was picked up by Jellyfin's own first-run
library scan with no manual refresh: a fresh node seeded with 8 movies + 2 series (16 top-level
items) reported all 16 through `/jellyfin/Items` immediately once first-run wiring completed, with
no call to `/jellyfin/Library/Refresh` at any point. `tools/ui-seed-media.ps1` still supports an
explicit `-RefreshNodeUrl` for the one case this does not cover -- re-seeding *new* titles into a
data dir whose node is already running (a library that already exists does not re-scan itself on a
timer fast enough to be useful for an interactive loop).

### Real artwork by default (F-12), offline gradients only behind `-OfflineArtwork`

**F-12 (Dan): "tests must use real movie images, never placeholders."** Real TMDB/TVDB artwork is
the default for everyone -- agents included -- in `tools/ui-seed-media.ps1`,
`tools/ui-node.ps1 -Seed` and `tools/ui-startup.ps1`. Pass `-OfflineArtwork` to any of the three to
fall back to the old deterministic gradients instead (no network dependency at all, at the cost of
not being a real image) -- e.g. no network access, or a deliberate no-network smoke test.

Two things had to be confirmed live (2026-09-06) before real artwork could work at all, both now
handled automatically:

1. **StingStream.Core's first-run wiring creates the Movies/TV Shows libraries with
   `EnableInternetProviders: false`** (confirmed via `GET /jellyfin/Library/VirtualFolders`) --
   despite `FirstRunService.cs`'s own comment that its `LibraryOptions` are "exactly as a stock
   install would do it." A library scan with providers off never fetches anything from TMDB/TVDB,
   real or otherwise.
2. **A local image file wins over any fetched one, regardless of that setting.** Forcing a full
   image refresh (`replaceAllImages=true`) on an item that already had a local `poster.jpg`
   produced no change at all after 90+ seconds of polling -- Jellyfin's local-file image provider
   is simply higher priority. So real-artwork mode has to do two things, not one: never write
   `poster.jpg`/`fanart.jpg` in the first place (the pre-start placement pass), **and** flip
   `EnableInternetProviders` on for both libraries once they exist (which needs the node's API, so
   it cannot happen before the node's first start creates them).

`ui-node.ps1 -Seed` therefore seeds with no local images by default, waits for first-run wiring
exactly as it always did, and then calls `ui-seed-media.ps1 -RefreshNodeUrl <url>` -- which PATCHes
`/Library/VirtualFolders/LibraryOptions` for each library (idempotent: skips a library that already
has providers on; preserves every other field on the existing `LibraryOptions` object rather than
POSTing a partial one, which would otherwise silently reset `EnableRealtimeMonitor`/`EnablePhotos`/
etc. to their C# defaults -- confirmed this matters, and confirmed the fix preserves them), triggers
`/Library/Refresh`, and polls the catalogue's first movie for a real `ImageTags.Primary` to appear
as the signal that a fetch actually happened, reporting how long it took. If the wiring wait itself
times out (the same shared-machine contention documented under "Verification" below), it warns and
skips the follow-up automatically -- run `ui-seed-media.ps1 -RefreshNodeUrl <url>` by hand once the
node finishes wiring. `tools/ui-startup.ps1` does the equivalent as its own step, and deliberately
places it **before** Playwright ever opens the page: T_home is meant to measure how fast Home shows
a poster that is already there, not how long a TMDB round trip takes, so the real-artwork wait is
its own untimed-budget step ahead of the Playwright step rather than folded into T_home.

**Measured on this machine, both modes confirmed end to end (2026-09-06):** offline mode's posters
carry the title only now (no caption); real mode's fetched `Big Buck Bunny` poster byte-matches the
film's actual theatrical artwork, and all 10 seeded titles fetched real images in every run tried.
Timing is genuinely conditions-dependent, not a fixed number -- enabling providers is always an
immediate `204`, but the identification-and-download pass that follows races this machine's other
concurrent load: one clean run reached all 10 real images within about 20-40 seconds of enabling
providers (the item-count poll went 4 -> 5 -> 7 -> 9 -> 10 across four 5-second cycles, and the
sample movie already had its image by the time that finished); one heavily-loaded run had not
finished identifying all 10 titles after 180 seconds and needed a second, longer wait budget (the
item-count wait is 420s under real artwork, kept at 180s only for `-OfflineArtwork`'s deterministic
NFO-only scan). Expect anywhere from under a minute to several minutes -- this is a real network
round trip to TMDB for every title, not a local operation, and shares the network/CPU with whatever
else is running on the machine.

---

## `tools/ui-seed-media.ps1`

Eight public-domain-titled movies (real TMDB ids) and two public-domain-titled series (real TVDB
ids), placed directly on disk with an NFO carrying the id -- lifted from `tools/e2e-m4.ps1`'s
`New-Clip`/`Write-MovieNfo`/`Install-Movie` (that file is untouched; the helpers are reproduced
here, not imported, since e2e-m4 deliberately keeps its own copies as a passing acceptance record --
see `docs/RUNNING.md`'s note on why `tools/e2e-common.ps1` doesn't own e2e-m3's/e2e-m4's helpers
either) plus new `Write-SeriesNfo`/`Install-Series` for the two shows.

| Movie | Year | TMDB | | Series | Year | TVDB |
|---|---|---|---|---|---|---|
| Big Buck Bunny | 2008 | 10378 | | The Beverly Hillbillies | 1962 | 71471 |
| Sintel | 2010 | 45745 | | Highway Patrol | 1955 | 190051 |
| Elephants Dream | 2006 | 9761 | | | | |
| Night of the Living Dead | 1968 | 10331 | | | | |
| Sita Sings the Blues | 2008 | 22820 | | | | |
| Tears of Steel | 2012 | 133701 | | | | |
| The Cabinet of Dr. Caligari | 1920 | 234 | | | | |
| Nosferatu | 1922 | 653 | | | | |

Both series get 3 Season-01 episodes each. Movies are 20s, episodes 30s, all 720p colour bars
encoded constant-bitrate the same way `e2e-m4.ps1`'s `New-Clip` does (`-minrate`/`-maxrate`/
`-bufsize` with `nal-hrd=cbr`) -- real, playable, non-trivial media, not a few-hundred-kilobyte
artifact of an ordinary `-b:v` target on a static test pattern.

**Artwork is real by default (F-12)**: no local `poster.jpg`/`fanart.jpg` is written at all, so
Jellyfin identifies each title from the `uniqueid` already in its NFO and fetches real TMDB/TVDB
poster/backdrop art -- see "Real artwork by default" below for what that actually takes (it is not
just "don't write the file"). Pass `-OfflineArtwork` for the old behaviour instead: a 600x900
`poster.jpg` and a 1920x1080 `fanart.jpg` per title, rendered entirely offline with `System.Drawing`
(GDI+, built into Windows) -- a diagonal gradient whose two colours are derived from a hash of the
title (so the same title always renders the same gradient and different titles are visibly
distinct, with no hand-maintained colour table) plus the title text, so a screenshot pass in this
mode never depends on TMDB's image CDN being reachable or serving the same poster twice. Both modes
are deterministic and idempotent: a second run with no `-Force` makes no changes (every clip, and
every `-OfflineArtwork` image, is skipped once it already exists at the expected path/size), so
`tools/ui-node.ps1 -Seed` is cheap on every start after the first.

---

## `tools/ui-startup.ps1`

The golden-startup acceptance harness. Wipes its own private data dir, seeds it, starts a node
(private copy, never the repo's build outputs), and times, on one clock started when the process
launched: **T_gateway** (TCP accept), **T_index** (`GET /` -> 200; once WP-GATE's node marker
exists, also checks `loopback`/`firstRun` in the injected `window.__STINGSTREAM_NODE__`, and prints
whether it was found -- until then 200 is the whole check), **T_healthy** (`/healthz` all enabled
children healthy), **T_wired** (`runtime.json`'s `first_run` flag clears). With `-DriveUi`,
Playwright then opens the page (reusing `tools/ui-shots`'s own Playwright install, so this package
carries the dependency exactly once) and measures **FCP** (first-contentful-paint, from the
`PerformanceObserver` paint entry) and **T_home** (a real poster with `naturalWidth > 0` on Home),
driving the first-run "Create your StingStream account" screen when it finds one (WP3) and falling
back to an ordinary sign-in with the seeded admin credentials (read via `--pass-file`, never
printed) until it exists. With `-Lan`, a second Playwright context opens the LAN URL and reports
whichever of the marker-based check or the pre-marker "finish setup on the computer" text it found.
Finally the node is restarted on the same data dir and an ordinary sign-in -> Home pass is timed
again as **T_home2** ("second-launch home").

Seeds with real TMDB/TVDB artwork by default (F-12; `-OfflineArtwork` falls back to the old
gradients). With `-DriveUi` and real artwork, once `T_wired` clears this script runs its own
untimed step -- enabling the libraries' internet image providers and waiting for a real poster --
**before** Playwright opens the page, so that step's own network time is never charged against
`T_home`; see "Real artwork by default" above for why and for the measured timing range.

Budgets, from the plan's own "Golden startup" acceptance section:

| Budget | Arrs off | Arrs on |
|---|---|---|
| T_gateway | < 2s | < 2s |
| T_index | < 3s | < 3s |
| T_healthy | < 40s | < 90s |
| T_wired | < 60s | < 120s |
| FCP | < 1.5s | < 1.5s |
| T_setup (setup screen interactive) | < 3s | < 3s |
| T_home | < 5s | < 5s |
| T_home2 (second-launch home) | < 3s | < 3s |

Exits 1 on any missed budget or failed step; every number is printed either way. The plan's
acceptance bar is **three runs in a row** meeting every budget -- this script is one run; loop it by
hand (or from the review-pass agent loop) to get three.

---

## `tools/ui-shots/`

Own `package.json` + lockfile, runs with plain `node`.

- **`shots.mjs`** -- `--base`, `--out`, `--user` (optional; defaults to the username in
  `--creds`/`--pass-file`), `--creds <file>` (a `{username,password}` JSON for a node whose
  first-run setup is already complete -- the normal case, see "F-36" below), `--pass-file`
  (legacy: `runtime.json`'s generated admin credentials, only usable before setup completes),
  `--first-run` (drive the real first-run screen to create the account, writing the credentials it
  used to `--creds` if given), `--lan <url>`, `--only <comma-separated screen ids>`. One browser,
  **one fresh context per viewport** (dark, reduced-motion), one page per context walked through
  every requested screen **in order** so a screen that depends on a prior action has something to
  act on. Every screen's `navigate()` is wrapped in try/catch: a screen this build cannot reach yet
  records a `navigate-failed` finding and the loop moves on to the next screen rather than losing
  the rest of the pass. Writes `<out>/<screen>-<viewport>.png` (viewport in the name is the
  *measured* `page.viewportSize()`, not the nominal config -- F-36), `<out>/findings.json`,
  `<out>/report.json`, `<out>/report.md`.
- **`flows/web.mjs`** -- the 13 screens, in order, and how to reach each from a fresh page; see
  "Pinned routes" below. `VIEWPORTS` (1440x900, 1024x768, 390x844 with `isMobile`,
  `deviceScaleFactor: 2`, `hasTouch: true`), `signIn`/`createFirstRunAccount` (the testID-driven
  auth flows, `connectAndSignIn` kept as an alias for `signIn`) and `clickTabByTestId` (the
  tab-bar-by-testID workaround, see "F-36" below) live here too.
- **`sweep.mjs`** -- `watchPage(page, {screen, viewport})` (call **before** navigating: console
  errors/warnings against `allowlist.json`, failed responses >= 400 against the same file,
  `pageerror`) and `sweepDom(page, {...})` (call once a screen has settled: page/element overflow,
  raw i18n keys -- `^[a-z0-9_]+(\.[a-z0-9_]+)+$` or any `en.json` key path verbatim -- brand words
  in text/title/`alt`/`aria-label`, tap targets < 40px at the mobile viewport, text < 12px, broken
  images, and a coarse Home-structure check at >= 1440px). The Home-structure check is a heuristic
  (a large element in the top 700px counts as a hero; a horizontally-overflowing container with >=
  4 loaded `<img>`s counts as a row) and says so in its own finding text -- real once the `home-hero`/
  `home-row` `testID`s below land, informational until then, the same spirit as the plan's own
  "optional axe pass, informational."
- **`allowlist.json`** -- known-benign console/response noise, as regexes. Starts empty on
  purpose: pass-00's findings are the old-UI baseline and are *meant* to be high (the plan's own
  words); only add an entry once a finding is genuinely understood and expected, never to make a
  number look better.
- **`report.mjs`** -- `buildReport(findings, meta)` (importable) and a standalone CLI
  (`node report.mjs --in findings.json --out <dir>`) producing the same `report.json`/`report.md`
  shape `shots.mjs` writes directly.
- **`lib/authFile.mjs`** -- `readAdminCredentials(passFilePath)` (legacy, pre-setup only -- WP-CORE
  scrubs the generated password from `runtime.json` once setup completes, so this stops working
  the moment it does), `readCreds`/`writeCreds(credsFilePath, {username,password})` (the F-36
  `--creds` file: read to sign in to an already-set-up node, written by `--first-run` after it
  creates the account). The one place any script in this package reads or writes a credentials
  file. Every other file imports this rather than parsing one itself.
- **`scripts/drive-startup.mjs`** / **`scripts/drive-login.mjs`** -- the Playwright drivers
  `tools/ui-startup.ps1 -DriveUi` shells out to. Not one of the six named deliverables, but they
  belong to this package for the same reason `lib/authFile.mjs` does: `ui-startup.ps1` needs
  Playwright, and this package already carries that dependency once.
- **`android.ps1`** -- see "Android" below.
- **`tv-flow.json`** -- D-pad key sequences per TV screen with settle times. **Data only.**
  WP-TV-SHELL's `scripts/tv-walk.ts` (its own package, per the plan's work-package table) is the
  intended replay/capture driver against this file; `android.ps1` exposes the same key-code table
  (`$TvKeys`) for an ad-hoc manual walk, but does not replay this file itself.

### Pinned routes

**Updated 2026-09-06 (pass-02 critique, F-36).** WP1's web shell has not landed yet, and merging
WP3/WP-GATE/WP-CORE/WP-TV-SHELL/WP-TV-LOGIN in the meantime changed what a bare URL resolves to:
`/requests`, `/groups`, and by the same construction `/search`, `/manage`, `/downloads`, now hit a
library-by-id catch-all route that spins forever and fires a ~400-request storm at the server in
about 3 seconds (the plan's F-21). That is not merely stale, it is actively harmful to keep doing,
so as of this pass **none of the six are pinned to a URL any more** -- `flows/web.mjs` reaches them
by clicking the bottom tab bar's own testID instead (see "F-36" below), which fails cleanly
(element not wired up yet) rather than hammering the server.

| Screen | Reached by | Notes |
|---|---|---|
| Login / first-run | `/login` | One route for the server-address step, the first-run create-account form, and the sign-in form; which one renders is state, not URL |
| Home | `/` | |
| Settings | `/settings` | **Still** direct navigation -- confirmed still correct on pass-02, unlike the six below |
| Search | tab testID | not a URL -- see "F-36" |
| Requests | tab testID | not a URL -- see "F-36" |
| Sharing (still "Groups") | `/settings` then a row click | no bottom tab; reached via Settings, itself still pinned |
| Manage | tab testID | not a URL -- see "F-36" |
| Transfers (still "Downloads") | tab testID | not a URL -- see "F-36" |
| Library | tab testID | not a URL -- see "F-36"; `04-library-movies` stays a best-effort text click after it |
| Details | **not pinned** | keyed by item id; reached by clicking a poster in the same session |
| Player | **not pinned** | reached by clicking Play from a reached Details screen |

**TODO (WP1):** re-pin Search/Library/Requests/Manage/Transfers/Sharing/Settings to real URLs once
WP1 lands `/home`, `/search`, `/library`, `/requests`, `/sharing`, `/manage`, `/transfers`,
`/settings` (the plan's own eventual set) -- tracked in `flows/web.mjs`'s own file header, not just
here, so whoever picks this up sees it in the code they are editing.

### Real bugs found pinning these routes (already on the plan's bug list; not fixed here)

1. **The desktop-width bottom tab bar does not navigate.** Six real `<button role>` elements with
   correct accessible names (Home, Search, Favorites, Library, Manage, Downloads) render at
   1440x900 -- but clicking any of them (confirmed directly, from a signed-in session, watching the
   URL) leaves the page on `/`. This is the plan's own "the bottom tab bar is a JS stub" bug,
   reproduced directly rather than only inferred from reading the source. It is also *why* the
   pinned-routes table above exists at all: every reachable screen in `flows/web.mjs` is reached by
   `page.goto()`, never by clicking the tab bar.
2. **Typing the bare host:port hangs the Connect step forever, with no visible error and no way
   back.** The app's own `/healthz` banner prints `http://127.0.0.1:8790` (no `/jellyfin`), and
   that is exactly what a first-time user would type. The app probes bare
   `<base>/System/Info/Public`, gets a 404, and the "Connect" control stays stuck in its
   pressed/loading state -- typing the *working* address afterwards and clicking Connect again does
   not recover either, because the first attempt never lets go of the page. `connectAndSignIn` in
   `flows/web.mjs` works around this by going straight to `<base>/jellyfin`, never the bare host.
   `docs/APP-RELEASE.md` section 11's claim that `checkJellyfinServer` "already retries under
   /jellyfin" was not observed to happen on this build.
3. **The first-launch IntroSheet ("Welcome to Streamyfin") auto-shows over Home** and is full of
   upstream brand words ("Streamyfin", "Jellyfin", "Seerr") -- both already on the plan's list
   (bug context; WP3/WP11 own the fix).
4. **Poster/backdrop `<img>` elements carry no `alt` text at all** (confirmed empty, not merely
   generic) -- a real accessibility gap, and it also means the brand-word `img[alt]` sweep check is
   permanently vacuous against this build (nothing to ever flag there, not because there is nothing
   wrong).
5. **Settings shows a raw stringified object**: "App version 7a80c91 · #[object Object]" -- visible
   directly in the pass-00 `07-settings` screenshots.
6. **`locator.isVisible({timeout})` does not retry** (a `flows/web.mjs`/Playwright-usage lesson,
   not an app bug): unlike every other Playwright action, `isVisible()` is an immediate, one-shot
   check. Calling it right after `page.goto()` races the SPA's own hydration and produced real,
   intermittent false negatives (the connect step being skipped outright) during this package's own
   verification. `flows/web.mjs` exports `isVisibleSoon()` (built on `locator.waitFor`, which does
   retry) for this reason -- if you add a new optional-element check to this file, use it, not
   `isVisible({timeout})`.

---

## Android

`tools/ui-shots/android.ps1`. Every action sets its own environment first (`JAVA_HOME=E:\Java\jdk-
17.0.20.101-hotspot`, `ANDROID_HOME`/`ANDROID_SDK_ROOT=E:\Android\sdk`,
`ANDROID_AVD_HOME=E:\Android\avd`, `GRADLE_USER_HOME=E:/g`, `platform-tools`/`emulator` prepended to
`PATH`) because the agent shell's own environment is stale (a JDK 15 on `PATH`, empty `ANDROID_*`).

- `-Emulator start|stop -Variant phone|tv` -- `stingstream-phone` (API 35) or `stingstream-tv` (API
  36), headless, `-gpu swiftshader_indirect`, waits for `sys.boot_completed`. Only one emulator is
  assumed running at a time.
- `-Build phone|tv` -- `expo prebuild --platform android --clean` (`EXPO_TV=0`/`1`) then `gradlew
  assembleDebug`, under the lock (see below), APK copied to `.win-temp\ui-loop\apk\<variant>\`.
  ~5-10 min warm, ~30 min cold. **Only run this when `modules/**`, `plugins/**`, `app.json` or a
  native dependency actually changed** -- see `docs/APP-DEV.md`; a JS-only change does not need it.
- `-Capture phone|tv` -- one `adb exec-out screencap -p`, piped through `Start-Process`'s
  file-based `-RedirectStandardOutput` rather than PowerShell's text-mode `>`/`Out-File`, which
  corrupts binary PNG bytes on Windows PowerShell 5.1.
- `-Metro -Variant phone|tv` -- starts the dev-client + Metro bundler (port 8081 phone / 8082 TV
  with `EXPO_TV=1`), `adb reverse`s it, launches via the dev-client deep link. The scheme is read
  live from `app.json`'s `expo.scheme` (`"streamyfin"` today, becomes `"stingstream"` once WP11
  lands) rather than hard-coded, so this script does not need editing when that changes.
- `-Logcat` -- dumps (does not stream) `ReactNativeJS:E` lines.
- `-Meminfo` -- `dumpsys meminfo <package>`, for the plan's TV PSS-delta (< 40 MB after five rows)
  acceptance check.

### The lock protocol

`apps/stingstream/android/` is regenerated wholesale by `expo prebuild --clean` for whichever
variant built last (`docs/CONTRIBUTING.md` rule 3), so two agents building different variants at
once corrupt each other's output. `-Build` takes
`E:\Dan\Documents\Repos\.win-temp\locks\android-dir.lock` (`agent=<name> variant=phone|tv
since=<ISO>`) before touching `android/`, and releases it once the APK is copied out. If the lock
is already held: **younger than 90 minutes**, this waits for it to clear, up to the remainder of
that budget; **90 minutes or older**, this refuses to touch it and throws, naming the stale lock --
breaking someone else's lock is the orchestrator's call, not this script's.

---

## Per-iteration agent checklist

1. Pull assigned `F-nn` fix-list items (from the review loop's `pass-NN\review.md`).
2. Tier A (`-DevServer`) until it looks right at 1440/1024/390.
3. `bun run typecheck && bun test && bun run i18n:check` (+ `bunx biome check --write --unsafe` on
   touched paths only -- `docs/CONTRIBUTING.md` rule 7); `cargo test -p stingstream` first if Rust
   changed, before starting a node (a running `stingstream.exe` holds the file a rebuild needs).
4. Tier B export (`bunx expo export --platform web --output-dir .win-temp\ui-loop\web-dist`),
   restart the node with `-WebDist` (or `-ForceCopy` if server-side code changed).
5. `node shots.mjs --only <touched screens>` -- zero new findings on the touched screens.
6. Android: dev-client reload (`-Metro`) + `-Capture` + `-Logcat` clean, only rebuilding
   (`-Build`) when native code changed.
7. `git add <explicit paths> && git commit --only <same paths> -F <msgfile>` naming the `F-nn` ids,
   in one shell invocation (`docs/CONTRIBUTING.md` rule 4); `git pull --ff-only` before pushing --
   stop and report rather than merging if it is not a fast-forward.
8. Report done, or needs-decision.

---

## Acceptance definitions (from the plan)

**Amazing UI** -- every screen at 1440x900, 1024x768 and 390x844 plus the phone and TV captures: 0
console errors, 0 failed requests outside the allowlist, 0 overflowing elements, 0 raw i18n keys, 0
brand words in visible text/alt/title/aria; Home at 1440 shows the hero and >= 2 rows of >= 4
loaded posters; at 390 no tap target < 40px, no text < 12px, no horizontal scroll; hover and
keyboard focus visible on web; every TV screen reachable and exitable by D-pad only with exactly
one preferred-focus element per screen, LEFT from column 0 opens the rail and RIGHT returns, no
`ReactNativeJS` errors, PSS delta < 40MB after five rows; source pill visible within 2s of
federated playback and absent on local playback; "Play from..." switches source within 5s at +/- 2s
of the position; web player: space/k, arrows, f, m, Escape, hover-to-show, cursor hide, fullscreen;
reviewer `ok` on every screen x viewport two passes running; Dan's own approval on the web build and
the sideloaded APKs.

**Golden startup** -- `ui-startup.ps1 -DriveUi -Lan -WithArrs` passes every budget three runs in a
row: fresh data dir -> `/` shows "Create your StingStream account" with nothing typed -> account
created -> home with seeded posters within 5s -> LAN IP shows "finish setup on the computer" ->
restart -> sign-in -> home; no console errors at any step; the generated password stops working and
is gone from `runtime.json`; `/jellyfin/web` 404 and `/jellyfin/Startup/*` not anonymous; the TV
emulator signs in with a code entered on the web build within 3s; the phone build signs in with no
setup screen.

---

## The `testID` contract (a request to the other work packages, not implemented here)

WP-TOOLS owns this contract, not the IDs themselves -- every `apps/stingstream/**` file belongs to
another package this wave (see the plan's ownership table). Until an ID lands, `shots.mjs`'s flows
fall back to text/role/URL selectors (see "Real bugs found pinning these routes" below for what
that already cost in reliability -- and F-36, "the sign-in step matched two password fields" was
exactly this: a fuzzy text-match break, fixed the moment a real `testID` existed to match instead).
Add each `testID` in the package that already owns the file it belongs on:

| `testID` | Screen / element | Owning package | Status |
|---|---|---|---|
| `firstrun-create-account` | The first-run "Create your StingStream account" form (container) | WP3 | **Landed** 2026-09-06 |
| `firstrun-username` / `firstrun-password` / `firstrun-confirm` / `firstrun-submit` | First-run form fields + submit | WP3 | **Landed** |
| `login-server-url` / `login-connect` | Server URL field + Connect button | WP3 | **Landed** |
| `login-username` / `login-password` / `login-submit` | Sign-in form fields + submit | WP3 | **Landed** |
| `tab-home` / `tab-library` / `tab-search` / `tab-favorites` / `tab-settings` / `tab-requests` / `tab-manage` / `tab-transfers` | Sidebar/tab-bar items | WP1 | Not landed. The bottom tab bar today auto-assigns `tab-(home)`, `tab-(search)`, `tab-(favorites)`, `tab-(libraries)`, `tab-(manage)`, `tab-(downloads)`, `tab-(requests)` -- the literal Expo Router group names (parens included) from whatever tab component is in use, not a deliberate `testID='tab-home'` prop. `flows/web.mjs`'s `clickTabByTestId` uses these as an interim measure; F-20 (the tab bar does not navigate) means clicking any of them does not actually change screens yet either. |
| `home-hero` | The Home hero/spotlight | WP4 | Not landed |
| `home-row` | Each Home row container | WP4 | Not landed |
| `library-card` | A poster/card in a grid | WP2 | Not landed |
| `details-play` | The Play button on Details | WP5 | Not landed |
| `player-video` | The `<video>`/player surface | WP-PLAYER | Not landed |
| `settings-sharing` | The Sharing entry in Settings | WP10 | Not landed |

Once one of these lands, tighten the matching selector in `tools/ui-shots/flows/web.mjs` (and,
where relevant, `sweep.mjs`'s Home-structure heuristic) to match against `[data-testid="..."]`
instead of text/role -- that is the entire point of the contract: a selector that survives a
rebrand or a copy change, rather than one that has to be re-pinned every time upstream text moves.
Confirmed live (2026-09-06): react-native-web's `createDOMProps` maps a component's `testID` prop
directly onto `data-testid` on the underlying DOM node, so `[data-testid="..."]` is always the
right web selector once a `testID` exists -- not an assumption, read out of
`node_modules/react-native-web/dist/cjs/modules/createDOMProps/index.js`.

---

## Verification (WP-TOOLS' own pass-00)

Run 2026-09-06 against a private copy of the then-current build (`mesh/target/debug/stingstream.exe`,
`server/jellyfin/.../bin/Debug/net10.0`, `apps/stingstream/dist` as the Tier B web bundle -- the
pre-WP0/WP1/... UI, on purpose: this is the baseline the plan's review loop measures every later
pass against). Numbers, findings and screenshots: `.win-temp\ui-loop\pass-00\` (outside the repo,
per `docs/CONTRIBUTING.md`).

**`ui-node.ps1 -Fresh -Seed`**: private copy made, config.toml written, gateway accepting
connections in ~1.6s, first-run wiring cleared (Jellyfin's own first scan picked up all 16 seeded
items with no manual refresh -- see above). `-DevServer` confirmed working against WP-GATE's now-
landed `--web-dev-server` flag (log line: `serving the app from a web dev server ... authority=
127.0.0.1:9999`).

**`shots.mjs`**, 8 of the 13 screens pinned and reachable (login, home, settings, requests, sharing,
search, manage, transfers) x 3 viewports = 24 captures, 0 navigation failures, 325 findings (console
123, response 83, small-text 60, overflow-element 34, tap-target 15, brand-word 9, home-structure
1) -- the pre-WP0/WP1 baseline this document says to expect, and already includes real,
previously-undocumented bugs (the six items above), not manufactured noise. 03/04/05/06 (library/
details/player) were skipped this pass -- their routes are not pinned yet (see "Pinned routes").

**`ui-startup.ps1 -DriveUi`**, HTTP-only phase, two runs after fixing the bugs below: seed+start
48-63s, T_gateway 1.6-2.6s, T_index 6.7-9.3s (budget 3s -- missed both times), T_healthy 66-88s
(budget 40s -- missed badly both times), T_wired cleared right after. Both misses track a
heavily-loaded shared machine at the time (several other agents' nodes and builds running
concurrently -- confirmed via process count and `Get-Process`), not the harness: the mechanics
(measurement, PASS/FAIL/MISS reporting, exit code, node cleanup on both the pass and the fail path)
were all confirmed correct. The Playwright phase (FCP/T_home) hit the same contention and timed out
around the 15s mark both times; `connectAndSignIn` itself was independently verified reliable (4/4
clean runs) once fixed and once the machine was less loaded moments earlier. Three-in-a-row budget
compliance is therefore **not yet demonstrated** and is flagged as open below.

**Android**: `android.ps1 -Emulator start -Variant phone` booted `stingstream-phone` in about a
minute; the existing debug APK (dev-client build) installed with `adb install -r` and launched with
no crash (`DevLauncherActivity`, `ReactNativeJS` logcat clean); `android.ps1 -Capture phone`
produced a real PNG via the binary-safe `Start-Process` redirect. TV skipped: no TV **debug** APK
exists yet, only the M5 release build under `apps/stingstream/release-builds/tv/`, which is a
different signing/build configuration and not what this check calls for.

**Bugs found and fixed by this verification pass, all in this package's own scripts**:
`Install-Movie` baked a stringified PowerShell object into every seed poster/fanart's title text
(`New-SeedArtwork -Title $Title` instead of `$Title.Title`); `ui-startup.ps1`'s own `$shotsDir`/
`$ShotsDir` case-collision silently redirected screenshots into the wrong directory; an
uninitialized `$script:tool2` under `Set-StrictMode` crashed the cleanup `finally` block whenever
the Playwright phase failed, masking the real error and leaking the node process; `New-SeedArtwork`
drew a second caption line ("StingStream UI loop seed") that rendered exactly where a real card's
own subtitle sits, reading as the item's own metadata on Home (removed, not reworded -- see "Real
artwork by default" above); a partial `POST` to `/Library/VirtualFolders/LibraryOptions` would have
silently reset every library field it did not name to its C# default, caught before it ever shipped
by preserving the whole existing options object instead; and (F-12 follow-up) a second, later call
to `ui-startup.ps1`'s enable-providers step referenced `$mediaRoot`, a variable local to a different
step's own scriptblock scope under PowerShell's `&`-creates-a-new-scope rule -- the same class of
bug as the `$shotsDir`/`$ShotsDir` collision, rebuilt from `$DataDir` instead of relying on it. Also
found, in the app rather than this package: first-run wiring's `Movies`/`TV Shows` libraries are
created with `EnableInternetProviders: false`, contradicted by their own source comment -- not
fixed here (Core's own default is not this package's to change), but no longer something a tester
has to work around by hand either, since real-artwork mode enables it itself. See the commit
history for `tools/ui-node.ps1`, `tools/ui-seed-media.ps1` and `tools/ui-startup.ps1` for the fixes
themselves.

---

## Pass-03 (F-27 / F-36, Fable's pass-02 critique, 2026-09-06)

Run against a fresh node with a fresh `bunx expo export` of then-current master (WP0, WP11,
WP-BRAND, WP3, WP-TV-SHELL, WP-TV-LOGIN, WP-GATE, WP-CORE, WP-TOOLS merged; not yet WP1/WP2/WP4/
WP5/WP-PLAYER/WP6-10) -- `.win-temp\ui-loop\pass-03-f36\`.

**F-27, seed overview text -- fixed and confirmed.** `Write-MovieNfo`/`Write-SeriesNfo` no longer
write a `<plot>` element at all (never wrote `<studio>`/`<tagline>`/`<outline>` either). Confirmed
live: Nosferatu's `Overview` is TMDB's real synopsis ("The mysterious Count Orlok summons a happily
married real estate agent..."), `Studios` is the real "Prana-Film", `Taglines` is the real "A
symphony of horror." -- no `movie.nfo`/`ui-seed-media.ps1` text anywhere in any of the three fields.

**F-36, sweep tooling -- fixed and confirmed:**
- **testID-driven auth.** `flows/web.mjs` now drives `firstrun-username`/`firstrun-password`/
  `firstrun-confirm`/`firstrun-submit` and `login-username`/`login-password`/`login-submit` by
  `[data-testid=...]` (WP3 landed these on master; confirmed react-native-web maps `testID` to
  `data-testid` by reading its source, not by assuming it). This is what actually fixed pass-02's
  own reported "the sign-in step matched two password fields" -- a fuzzy accessible-name collision
  between "Password" and "Confirm password" that a `data-testid` match cannot have.
- **`--creds`.** `shots.mjs --first-run --creds <file>` creates the account through the real
  first-run screen and writes `{username,password}` to `<file>`; a later `shots.mjs --creds <file>`
  (no `--first-run`) signs in with it. Confirmed live: `--first-run` against a truly fresh node,
  then `--creds` against the by-then-set-up node, both worked. Also caught and fixed in the same
  pass: `--first-run` was re-attempting account creation on every one of the three viewport
  contexts (each is a fresh browser context, but they all share the one node/account underneath),
  which correctly failed on the 2nd/3rd viewport with "this node has already been set up" --
  `shots.mjs` now creates the account once and signs in with the just-created credentials for the
  rest. `tools/ui-shots/scripts/drive-startup.mjs` (used by `ui-startup.ps1 -DriveUi`) was also
  switched from text-matching to the same `firstrun-*` testIDs, reusing `createFirstRunAccount`
  instead of duplicating the fill/submit logic.
- **Brand-word sweep false positives -- fixed.** WP-GATE's injected `<script>
  window.__STINGSTREAM_NODE__={...,"jellyfin":"/jellyfin",...}</script>` marker has a text-node
  child (its own source), which the sweep's text-carrier scan does not distinguish from visible
  copy by default -- `sweep.mjs` now excludes `script`, `style`, `noscript`, `title` and
  `meta[name="stingstream-node"]` from every text-based check. Confirmed live: zero marker-related
  brand-word findings on this pass; the brand-word findings that remain are real (the literal
  server URL, "http://127.0.0.1:8795/jellyfin", rendered as visible text on Settings/Requests/
  Sharing/Search -- matching the critique's own F-30 finding about Settings' data dump).
- **PNG names carry the real viewport width -- fixed.** `shots.mjs` now names every screenshot (and
  tags every finding) with `page.viewportSize()`'s actual measured `{width}x{height}`, not the
  nominal config name, so a filename is never a claim the script did not verify itself.
- **Section routes re-pinned to tab clicks, with a TODO for WP1.** `/requests`/`/groups`/`/search`/
  `/manage`/`/downloads` now resolve to a library-by-id catch-all that spins forever and hammers the
  server (~400 requests in 3s) -- a regression since pass-00, and actively harmful to keep doing.
  `flows/web.mjs` reaches these by clicking the bottom tab bar's own (pre-contract) testIDs instead
  -- `tab-(home)`, `tab-(search)`, `tab-(favorites)`, `tab-(libraries)`, `tab-(manage)`,
  `tab-(downloads)`, `tab-(requests)`, the literal Expo Router group names a tab component
  auto-assigns today, not yet WP1's clean `tab-home`/`tab-library`/... contract -- and verifies the
  URL actually changed, throwing an honest F-20 finding if not rather than silently screenshotting
  Home under the wrong screen's name. `/settings` stays pinned to a direct URL (still confirmed
  correct on this pass). A `TODO(WP1)` comment sits directly on `clickTabByTestId` in the code.

**Confirmed live, and worth recording precisely because it contradicts the critique's own blanket
"the tab bar does nothing" line: clicking `tab-(search)` and `tab-(requests)` DOES navigate** (real
Search and Requests screens captured, tab bar visibly highlighting the active item) **while
`tab-(manage)` and `tab-(downloads)` do not** (confirmed `navigate-failed`, URL unchanged). F-20 is
therefore real but partial, not uniform -- worth WP1 knowing which tabs are already half-wired.

**Full run** (`shots.mjs --first-run --creds`, all 13 screens x 3 viewports): **zero
`navigate-failed` findings on every screen confirmed reachable** (login, home, settings, requests,
sharing, search) -- the verification bar this pass was held to. 354 findings total, all attributable
to real, specific causes (console noise matching the critique's own F-23 list, tab-label overflow
at 390px matching F-20's "every label truncates," the visible `/jellyfin` URL matching F-30), none
of them the marker false-positive or the fuzzy-selector failures this pass set out to fix.
