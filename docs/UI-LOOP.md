# The UI iterate loop (WP-TOOLS)

Tooling for v0.2.0's "iterate loop" (the plan's Part 2, section "The iterate loop"): run a private
StingStream node, seed it with deterministic offline test media, screenshot every screen at every
viewport, sweep each one for real problems, and drive the golden-startup budgets end to end. All of
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
there -- confirmed to matter, see "Does first-run wiring scan pre-placed files?" below), `-Stop`.

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

**Artwork is rendered entirely offline** with `System.Drawing` (GDI+, built into Windows): a
600x900 `poster.jpg` and a 1920x1080 `fanart.jpg` per title, a diagonal gradient whose two colours
are derived from a hash of the title (so the same title always renders the same gradient and
different titles are visibly distinct, with no hand-maintained colour table) plus the title text.
No screenshot pass ever depends on TMDB's image CDN being reachable or serving the same poster
twice. Deterministic and idempotent: a second run with no `-Force` makes no changes (every clip and
every image is skipped once it already exists at the expected path/size), so `tools/ui-node.ps1
-Seed` is cheap on every start after the first.

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
  `--pass-file`), `--pass-file` (path to `runtime.json`, read silently), `--first-run`, `--lan
  <url>`, `--only <comma-separated screen ids>`. One browser, **one fresh context per viewport**
  (dark, reduced-motion), one page per context walked through every requested screen **in order**
  so a screen that depends on a prior action has something to act on. Every screen's `navigate()`
  is wrapped in try/catch: a screen this build cannot reach yet records a `navigate-failed` finding
  and the loop moves on to the next screen rather than losing the rest of the pass. Writes
  `<out>/<screen>-<viewport>.png`, `<out>/findings.json`, `<out>/report.json`, `<out>/report.md`.
- **`flows/web.mjs`** -- the 13 screens, in order, and how to reach each from a fresh page; see
  "Pinned routes" below. `VIEWPORTS` (1440x900, 1024x768, 390x844 with `isMobile`,
  `deviceScaleFactor: 2`, `hasTouch: true`) and `connectAndSignIn` (the shared sign-in flow) live
  here too.
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
- **`lib/authFile.mjs`** -- `readAdminCredentials(passFilePath)`. The one place any script in this
  package reads `runtime.json`'s admin password. Every other file imports this rather than parsing
  `runtime.json` itself.
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

Confirmed live against a running node on 2026-09-06 (signed in as the seeded admin, 1440x900),
recorded here so nobody re-discovers them from scratch:

| Screen | URL | How confirmed |
|---|---|---|
| Login / connect | `/login` | One route for both the server-address and username/password steps; state, not URL |
| Home | `/` | |
| Settings | `/settings` | direct navigation; the desktop tab bar cannot reach it (see below) |
| Search | `/search` | direct navigation |
| Requests | `/requests` | direct navigation |
| Sharing (still "Groups") | `/groups` | direct navigation |
| Manage | `/manage` | direct navigation |
| Transfers (still "Downloads") | `/downloads` | direct navigation; real content confirmed ("Engine health", "No active downloads") |
| Library | **not pinned** | see below |
| Details | **not pinned** | keyed by item id; reached by clicking a poster in the same session |
| Player | **not pinned** | reached by clicking Play from a reached Details screen |

**Library's real URL was not pinned.** Both `/library` and `/libraries` answer without erroring but
neither was distinguished from the other, or from the broken-tab-bar no-op below, in the time
available. `03-library`/`04-library-movies` stay `optional: true` with a best-effort text-based
click. Confirm by hand or once WP1/WP2 land the sidebar.

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
another package this wave (see the plan's ownership table). Until these land, `shots.mjs`'s flows
fall back to text/role/URL selectors (see "Real bugs found pinning these routes" above for what
that already cost in reliability). Add each `testID` in the package that already owns the file it
belongs on:

| `testID` | Screen / element | Owning package (per the plan) |
|---|---|---|
| `firstrun-create-account` | The first-run "Create your StingStream account" form | WP3 |
| `login-server-url` | Server URL field | WP3 |
| `login-connect` | Connect button | WP3 |
| `login-username` | Username field | WP3 |
| `login-password` | Password field | WP3 |
| `login-submit` | "Sign in" button | WP3 |
| `tab-home` / `tab-library` / `tab-search` / `tab-favorites` / `tab-settings` / `tab-requests` / `tab-manage` / `tab-transfers` | Sidebar/tab-bar items | WP1 |
| `home-hero` | The Home hero/spotlight | WP4 |
| `home-row` | Each Home row container | WP4 |
| `library-card` | A poster/card in a grid | WP2 |
| `details-play` | The Play button on Details | WP5 |
| `player-video` | The `<video>`/player surface | WP-PLAYER |
| `settings-sharing` | The Sharing entry in Settings | WP10 |

Once one of these lands, tighten the matching selector in `tools/ui-shots/flows/web.mjs` (and,
where relevant, `sweep.mjs`'s Home-structure heuristic) to match against `[data-testid="..."]`
instead of text/role -- that is the entire point of the contract: a selector that survives a
rebrand or a copy change, rather than one that has to be re-pinned every time upstream text moves.

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

**Three real bugs found and fixed by this verification pass, all in this package's own scripts**:
`Install-Movie` baked a stringified PowerShell object into every seed poster/fanart's title text
(`New-SeedArtwork -Title $Title` instead of `$Title.Title`); `ui-startup.ps1`'s own `$shotsDir`/
`$ShotsDir` case-collision silently redirected screenshots into the wrong directory; and an
uninitialized `$script:tool2` under `Set-StrictMode` crashed the cleanup `finally` block whenever
the Playwright phase failed, masking the real error and leaking the node process. See the commit
history for `tools/ui-node.ps1`, `tools/ui-seed-media.ps1` and `tools/ui-startup.ps1` for the fixes
themselves.
