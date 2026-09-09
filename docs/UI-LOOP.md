# The UI iterate loop (WP-TOOLS)

Tooling for v0.2.0's "iterate loop" (the plan's Part 2, section "The iterate loop"): run a private
StingStream node, screenshot every screen at every viewport, sweep each one for real problems, and
drive the golden-startup budgets end to end. All of
it lives under `tools/ui-node.ps1`, `tools/ui-startup.ps1` and
`tools/ui-shots/**`. This package owns those files and this document; it does not own any
`apps/stingstream/**` source file -- every screen this loop screenshots belongs to another work
package, and the `testID` contract below is a request to those packages, not something this
package implements.

> **No test media, as of 2026-09-09.** The loop used to seed a node with 8 public-domain-titled
> movies and 2 series (`tools/ui-seed-media.ps1`, `ui-node.ps1 -Seed`). Dan asked for that removed
> -- a local node was coming up showing sample content -- so the script is deleted and the `-Seed`
> / `-OfflineArtwork` switches are gone from `ui-node.ps1` and `ui-startup.ps1`. A node now starts
> on an **empty** media root. Screenshots and `T_home` therefore render whatever the machine
> actually holds; put real content under `<DataDir>\media\Movies` / `\TV` by hand if a shot needs
> a populated library. The historical sections below (Verification, Pass-03..05) describe runs
> made *before* this and still refer to the seeder; they are kept as a record, not as instructions.

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
`E:\Dan\Documents\Repos\StingStream\.local\ui-loop\`:

```
.local\ui-loop\
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
# Start a private node: Jellyfin + mesh only (no arrs), fresh data dir, empty media root,
# Tier B if a web-dist export already exists at the default location.
powershell tools\ui-node.ps1 -Fresh

# Point it at a running Metro dev server instead (Tier A).
powershell tools\ui-node.ps1 -DevServer http://127.0.0.1:8081

# Full node (Radarr/Sonarr/NZBGet too), bound to loopback only.
powershell tools\ui-node.ps1 -Fresh -WithArrs -Bind 127.0.0.1

# Stop whatever is running against the default data dir.
powershell tools\ui-node.ps1 -Stop

# Screenshots + sweep + report, three viewports, against a running node.
cd tools\ui-shots
node shots.mjs --base http://127.0.0.1:8795 --out ..\..\.local\ui-loop\pass-00\web `
  --pass-file ..\..\.local\ui-loop\data\runtime.json

# One screen, all viewports, while iterating on it.
node shots.mjs --base http://127.0.0.1:8795 --out <dir> --pass-file <runtime.json> --only 02-home

# The golden-startup acceptance run.
powershell tools\ui-startup.ps1 -WebDist E:\Dan\Documents\Repos\StingStream\.local\ui-loop\web-dist -DriveUi -Lan

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
see "The `--web-dev-server` flag" below), `-Stop`.

The data dir's `media` root is created empty and nothing fills it -- see the note at the top of
this document. If a screen you are iterating on needs a populated library, place real files under
`<DataDir>\media\Movies` / `<DataDir>\media\TV` **before** the node's first start, so the first
library scan finds them already there; that ordering is confirmed to matter -- see "Does first-run
wiring scan pre-placed files?" below.

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
library scan with no manual refresh: a fresh node holding 8 movies + 2 series (16 top-level items)
reported all 16 through `/jellyfin/Items` immediately once first-run wiring completed, with no call
to `/jellyfin/Library/Refresh` at any point. This is still the rule to follow when placing real
content by hand: get the files down first, then start the node. The one case it does not cover is
adding *new* titles to a data dir whose node is already running -- a library that already exists
does not re-scan itself on a timer fast enough for an interactive loop, so POST
`/jellyfin/Library/Refresh` yourself.

---

## `tools/ui-startup.ps1`

The golden-startup acceptance harness. Wipes its own private data dir, starts a node on an empty
media root (private copy, never the repo's build outputs), and times, on one clock started when the process
launched: **T_gateway** (TCP accept), **T_index** (`GET /` -> 200; once WP-GATE's node marker
exists, also checks `loopback`/`firstRun` in the injected `window.__STINGSTREAM_NODE__`, and prints
whether it was found -- until then 200 is the whole check), **T_healthy** (`/healthz` all enabled
children healthy), **T_wired** (`runtime.json`'s `first_run` flag clears). With `-DriveUi`,
Playwright then opens the page (reusing `tools/ui-shots`'s own Playwright install, so this package
carries the dependency exactly once) and measures **FCP** (first-contentful-paint, from the
`PerformanceObserver` paint entry) and **T_home** (an image with `naturalWidth > 0` on Home),
driving the first-run "Create your StingStream account" screen when it finds one (WP3) and falling
back to an ordinary sign-in with the generated admin credentials (read via `--pass-file`, never
printed) until it exists. With `-Lan`, a second Playwright context opens the LAN URL and reports
whichever of the marker-based check or the pre-marker "finish setup on the computer" text it found.
Finally the node is restarted on the same data dir and an ordinary sign-in -> Home pass is timed
again as **T_home2** ("second-launch home").

**`T_home` caveat since test media was removed (2026-09-09).** The wait is "any `img` with
`naturalWidth > 0`", which used to be satisfied by a seeded poster. On an empty library it is
satisfied only if Home renders an image of its own (logo, empty-state art). If `T_home` starts
timing out on a machine with no media, that is the reason -- not a regression in startup.

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
- **`flows/web.mjs`** -- the 15 screens, in order, and how to reach each from a fresh page; see
  "Pinned routes" below. `VIEWPORTS` (1440x900, 1024x768, 390x844 with `isMobile`,
  `deviceScaleFactor: 2`, `hasTouch: true`), `signIn`/`createFirstRunAccount` (the testID-driven
  auth flows, `connectAndSignIn` kept as an alias for `signIn`) live here too. `NAV`/`navigateViaNav`
  drive Requests/Sharing by a real nav click as well as by URL (see "Pinned routes"), reading the
  768px `isWebWide` breakpoint (`apps/stingstream/hooks/useBreakpoint.ts`) to pick the desktop
  sidebar's testID or the compact bar/More screen's.
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
- **`allowlist.json`** -- known-benign console/response noise, as regexes (`console`/`responses`),
  plus `smallTextSelectors` -- CSS selectors (not regexes) exempting matching elements from the
  small-text (<12px) check. Starts empty on purpose: pass-00's findings are the old-UI baseline and
  are *meant* to be high (the plan's own words); only add an entry once a finding is genuinely
  understood and expected, never to make a number look better. One entry as of this pass:
  `[data-testid="shell-tabbar"] *`, for the compact tab bar's 11px labels (`TAB_LABEL_FONT_SIZE`,
  `tabIcons.ts`) -- deliberate, F-08, not a defect.
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

**Updated 2026-09-06 (WP1 landed on master, `dbdee21`) -- the pass-02 TODO above is resolved.**
WP1 gave every section a real URL of its own (`apps/stingstream/components/shell/tabIcons.ts`
`TAB_PATHS`, plus Sharing/Settings/Sessions, which are not tab groups) and each route group also
has a named file at its own path, so the old collision at `/` (F-20/F-21: `/requests` etc. fell
through to a `(libraries)/[libraryId]` catch-all and spun, hammering the server with a
~400-request storm) is gone -- confirmed live, this pass, that every route below lands on the
right screen. Almost everything is pinned to a direct URL again as a result.

| Screen | Reached by | Notes |
|---|---|---|
| Login / first-run | `/login` | One route for the server-address step, the first-run create-account form, and the sign-in form; which one renders is state, not URL |
| Home | `/` | `/home` also exists, as a redirect |
| Library | `/library` | `04-library-movies` stays a best-effort text click after it |
| Settings | `/settings` | |
| Requests | `/requests` -- **and** a nav click | Both paths, on purpose: `08-requests` navigates by URL, then *also* clicks `tab-requests` (the compact bar at <768px, the desktop sidebar row at >=768px -- same testID, `tabTestID()` is shared) and checks the URL again. Requests was pass-02's worst F-20/F-21 case, so this screen keeps double-checking it. |
| Users | `/users` -- **and** a nav click | Same "both paths" treatment as Requests. No compact-bar tab of its own: at <768px reached via `tab-more` -> `more-users` inside `more-screen`; at >=768px a direct sidebar row, `tab-users`. Administrator-only on both surfaces, unlike the Sharing row it replaced. |
| Search | `/search` | |
| Manage | `/manage` | |
| Transfers | `/transfers` | |
| Favorites | `/favorites` | New this pass (`14-favorites`) |
| More | `/more` | New this pass (`13-more`), **390px only** -- the "More" screen is a compact-only concept (`buildMoreItems`); at >=768px the same rows are direct sidebar items and there is nothing distinct to shoot |
| Details | **not pinned** | keyed by item id; `05-details` starts from Home (not wherever the prior screen left off) and clicks the first `library-card`, asserting the resulting URL is not one of the section URLs above -- Home's rows are real item cards only, so this cannot land on a library tile the way the Libraries screen's own `library-card`-tagged tiles could |
| Player | **not pinned** | `06-player` clicks the details page's own `details-play` testID |

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
  assembleDebug`, under the lock (see below), APK copied to `.local\ui-loop\apk\<variant>\`.
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
`E:\Dan\Documents\Repos\StingStream\.local\locks\android-dir.lock` (`agent=<name> variant=phone|tv
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
4. Tier B export (`bunx expo export --platform web --output-dir .local\ui-loop\web-dist`),
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
created -> home rendered within 5s -> LAN IP shows "finish setup on the computer" ->
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
| `tab-home` / `tab-search` / `tab-library` / `tab-requests` / `tab-more` | Compact bottom tab bar (`shell-tabbar`, <768px) and desktop sidebar (`buildSidebarItems.ts`, >=768px) -- same testID, shared via `tabTestID()` | WP1 | **Landed** 2026-09-06 (`dbdee21`). The old auto-assigned `tab-(home)`-style ids (literal Expo Router group names) are gone; querying for one now finds nothing. |
| `tab-favorites` / `tab-watchlists` / `tab-custom-links` / `tab-manage` / `tab-transfers` | Same shared `tabTestID()` ids -- desktop sidebar rows, and (for the ones not on the compact bar) rows inside the phone's `more-screen` too | WP1 | **Landed** |
| `tab-users` / `tab-settings` | Desktop sidebar-only rows (>=768px) for Users/Settings, which are not tab groups | WP1 | **Landed** (`tab-users` replaced `tab-sharing` 2026-09-09) |
| `more-users` / `more-settings` / `more-sessions` | Phone-only `more-screen` rows (<768px) for the same three destinations. `more-users` is administrator-only, so a member's More screen has neither it nor an admin group | WP1 | **Landed** (`more-users` replaced `more-sharing` 2026-09-09) |
| `shell-tabbar` | The compact bottom tab bar's own container | WP1 | **Landed** |
| `more-screen` | The phone "More" screen's container | WP1 | **Landed** |
| `header-mark` / `header-back-to-more` | Top bar's app mark / back-to-More chevron | WP1 | **Landed** |
| `home-hero` | The Home hero/spotlight | WP4 | Not landed |
| `home-row` | Each Home row container | WP4 | Not landed |
| `library-card` | A poster/card -- both a real item card (`components/cards/Card.tsx`) and the Libraries screen's own "Movies"/"TV Shows" tiles (`components/library/LibraryItemCard.tsx`) carry this exact id, not just item cards | WP2 | **Landed** 2026-09-08 |
| `details-play` | The Play/Resume button on Details (`components/PlayButton.tsx`) | WP5 | **Landed** |
| `player-video` | The `<video>`/player surface | WP-PLAYER | Not landed |
| `settings-users` / `settings-servers` | The Users and Servers entries in Settings | WP10 | **Landed** 2026-09-09 |
| `users-screen` / `users-invite` / `users-account` / `users-pending` | The Users screen, its Invite button, and the two kinds of row | WP10 | **Landed** 2026-09-09 |

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
pass against). Numbers, findings and screenshots: `.local\ui-loop\pass-00\` (outside the repo,
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
WP5/WP-PLAYER/WP6-10) -- `.local\ui-loop\pass-03-f36\`.

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

---

## Pass-04 (WP1 route/testID re-pin, `dbdee21`, 2026-09-06)

Run against a fresh node: fresh `bunx expo export` of master (`dbdee21` -- WP1 landed, plus
everything through it), `-ForceCopy` to pick up the current `stingstream.exe`/Jellyfin build,
`-Fresh -Seed` (real artwork, the F-12 default). `shots.mjs --first-run --creds` -- all 16 screens
(the 13 from pass-03 plus `13-more` and `14-favorites`) x 3 viewports.
`.local\ui-loop\wp1-repin\`.

**Re-pin -- fixed and confirmed.** Every section in "Pinned routes" above now navigates the way
that table says: direct `page.goto()` for Home/Library/Settings/Search/Manage/Transfers/Favorites,
`13-more` gated to 390px only, and `08-requests`/`09-users` doing BOTH a direct URL nav and a
`navigateViaNav()` click (the compact bar + More screen at 390px, the desktop sidebar at
1024/1440px) with a URL check after each. **Zero `navigate-failed` findings on any of these nine
screens, at any of the three viewports** -- the acceptance bar this pass was held to. Confirmed by
hand, not just by the absence of a finding: read `08-requests-1440x900.png` and
`09-users-390x844.png` back after the run -- Requests highlights correctly in the desktop
sidebar, the section's content renders correctly reached via `tab-more` at 390px, and
`13-more-390x844.png` shows the real More screen (Favorites / Manage, Transfers, Sessions /
Sharing, Settings -- Watchlists and Custom Links absent because this seed's settings do not turn
either on, which is correct, not a bug).

The 11 `navigate-failed` findings that remain are exactly the ones expected to remain, all
`optional: true`, none of them one of the nine: `00b-first-run-lan` x3 (`--lan` was not passed this
run), `00-first-run-local` x2 at the 2nd/3rd viewport (the account already exists by then --
`firstRunAccountCreated` behaving exactly as pass-03 documented), `05-details` x3 and `06-player`
x3 (the best-effort `img`/`getByRole` click landed on the Library screen's own "Movies"/"TV Shows"
tile rather than a real item poster -- `library-card`/`details-play` still have no testID, per the
contract table; not a regression, `03-library`/`04-library-movies` reaching the Library screen at
all is new this pass, `05`/`06` were skipped outright before it).

**Small-text allowlist -- fixed and confirmed.** `allowlist.json`'s new `smallTextSelectors`
(`[data-testid="shell-tabbar"] *`) suppresses the compact bar's 11px labels: confirmed live, both
ways -- a direct `page.evaluate()` against a signed-in 390px session found `shell-tabbar`'s five
labels ("Home"/"Search"/"Library"/"Requests"/"More") really are 11px, and the same run's 62
small-text findings contain zero of them (they are all real: `02-home`'s year badges at 390px,
e.g. `<div> 11px "1922"`). The allowlist is a CSS-selector exemption, not a blanket size bump --
confirmed it does not swallow an unrelated genuine finding.

**Seed library-tile images -- fixed within this package's scope; one root cause is not this
package's to fix.** `New-LibraryTileImage` (new function, `ui-seed-media.ps1`) never writes a
`folder.jpg` for `Movies`/`TV` in real-artwork mode (confirmed live: `real artwork: no local
folder.jpg for Movies (Jellyfin composes it from posters)` in this run's own log), and in
`-OfflineArtwork` mode writes a plain hue-gradient `folder.jpg` with no `DrawString` call at all
(confirmed by reading the file back: a clean diagonal gradient, no text, no library name). That
said: **the "Movies"/"TV Shows" name shown twice on the Libraries grid is still visible in this
pass's own `03-library-1440x900.png`**, with real artwork and no local `folder.jpg` from this
script either way. Reading the screenshot closely, the large centered text is baked into the
library's own composed tile *above* the app's own smaller "Movies"/"TV Shows" card caption below
it -- i.e. it is Jellyfin's/the app's own rendering of the library's auto-composed cover image,
not a file `ui-seed-media.ps1` ever writes (this script writes no `Movies`/`TV` folder image at
all in real-artwork mode, and never did before this pass either). This package owns no file that
produces that overlay -- it is either Jellyfin's own CollectionFolder image compositing or a
client-side card treatment in `apps/stingstream/**`, both out of `tools/ui-seed-media.ps1`'s reach.
Flagging for whichever work package owns the Library screen's card component or the
CollectionFolder image request, rather than silently marking this done.

**Credential handling -- fixed and confirmed, including the exact failure WP2 reported.**
`lib/authFile.mjs`'s `readAdminCredentials()` (read a node's `runtime.json` directly) is removed
outright, along with every `--pass-file` consumer (`shots.mjs`, `scripts/drive-login.mjs`,
`scripts/drive-startup.mjs`, `tools/ui-startup.ps1`'s two Playwright invocations) -- WP2 found the
real bug this was hiding: WP-CORE's setup renames the bootstrap admin and scrubs the generated
password out of `runtime.json` once setup completes, so a *second* script run against the same,
by-then-set-up data dir (exactly what `ui-startup.ps1`'s own "restart, then an ordinary login" step
does) threw instead of signing in. Every script in this package now uses the F-36 `--creds` file
(`{username,password}`, never `runtime.json`) end to end: `drive-startup.mjs` drives the real
first-run screen itself and writes the account it creates to `--creds`; `drive-login.mjs` reads it
back for the restart pass; `ui-startup.ps1` threads one `$CredsPath` (`<DataDir>\ui-loop-creds.json`,
a top-level script variable for the same PowerShell-scoping reason `$DataDir` is) through both
steps.

`ui-startup.ps1 -DriveUi`'s own end-to-end run could not complete this pass -- see "T_healthy
contention" below, an unrelated infrastructure problem -- so both new code paths were verified
directly against the pass-04 node instead, by hand, after confirming its `runtime.json` really had
been scrubbed (`jellyfin_admin` had `{"username":"stingstream"}`, no `password` key -- the exact
state that broke `readAdminCredentials()`): `node scripts/drive-login.mjs --creds ...` against it
signed in and reached Home in 10.97s; `node scripts/drive-startup.mjs --creds ...` against the same
already-set-up node correctly took the "no first-run setup screen -- signing in with --creds"
branch and reached Home in 17.51s. Both are the exact scenario WP2 reported broken, both now work.

**T_healthy contention (infrastructure, not a regression).** Two `-DriveUi` attempts both failed at
`T_healthy` (100s timeout, `/healthz` never answered) before ever reaching the Playwright step --
neither is one of this pass's own screens or scripts. `tasklist` showed 17-21 concurrent
`stingstream.exe` processes on this shared machine both times (several other agents' nodes
building/running at once -- the same contention pass-00's own verification section documents
missing `T_healthy`/`T_wired` for). Confirmed this is not a functional break in the current build:
this pass's OTHER node (the one `shots.mjs` ran all 16 screens against, above), started earlier and
never restarted, answered `/healthz` with `"status":"ok"` and both `jellyfin`/`mesh` `"state":
"healthy"` at the same moment the second `-DriveUi` attempt was timing out. Not re-attempted a
third time given the trend (131.3s vs. 87.0s for the same "wipe -> seed -> start" step, second
attempt slower) -- worth another `-DriveUi` run once the machine is less loaded, but is a real gap:
the budget-timing numbers (`FCP`/`T_setup`/`T_home`/`T_home2`) this section reported in pass-00 are
not re-confirmed this pass.

---

## Pass-05 (`05-details`/`06-player` re-pin to `library-card`/`details-play`, 2026-09-08)

WP2's/WP5's `library-card`/`details-play` testIDs landed after pass-04. `05-details` used to click
`page.locator("img").first()`; on a page showing the Libraries screen's own "Movies"/"TV Shows"
tiles (`components/library/LibraryItemCard.tsx`), the first `<img>` is the tile's own artwork, not
an item's poster -- confirmed live, this pass, that this is exactly what pass-04's `05-details`
findings were: `04-library-movies`'s best-effort text click did not reliably land inside the Movies
library's own item grid, so `05-details` clicked the Libraries tile and bounced straight back.

**Fixed and confirmed.** `library-card` turned out not to be a safe "first match" selector either
on its own: `LibraryItemCard.tsx` (the Libraries screen's tiles) uses the identical testID as
`Card.tsx` (a real item card), so "the first `library-card` on the page" is still ambiguous unless
the page is known to have no library tiles on it at all. `05-details` now starts from Home
(`gotoUrl(page, base, "home")`) rather than trusting whatever the previous screen left behind --
Home's rows are real item cards only -- then clicks the first `library-card` there and asserts the
resulting URL is not one of this file's own fixed section URLs (`Object.values(URLS)`), which is
the one thing a bounce-back or a stray library click would both produce and a real item route never
would. `06-player` now clicks the details page's own `details-play` button instead of a
role/name guess (`getByRole("button", {name: /play|resume/i})`, which pass-04 already flagged as
best-effort).

Verified with `shots.mjs --only 05-details,06-player` against a fresh node (real artwork,
`dbdee21`+ master): both screens `ok` at all three viewports, zero `navigate-failed`. Read back by
hand, not just the absence of a finding: `05-details-1440x900.png` is a fully loaded Nosferatu
details page (real TMDB poster, rating, overview, cast row -- F-27's no-`<plot>` fix still holding,
the overview is TMDB's real synopsis, not seed text), and `06-player-1440x900.png` is a real,
playing video (the seed clip's colour-bar pattern, OSD controls, "Ends at" time) -- the whole
Home -> item -> playback chain confirmed working, not just "didn't throw." One extra fix along the
way: the first attempt's `05-details` screenshots caught the details page mid-skeleton
(`page.waitForLoadState("networkidle")` settles before the item's own data fetch finishes) --
added a non-fatal wait for `details-play` to become visible before shooting, which doubles as "the
page has real content" since `06-player` needs that same element anyway. 28 findings across the two
screens x three viewports (overflow/i18n-key/console/tap-target), none of them `navigate-failed`
and none introduced by this fix -- the same classes of pre-existing, already-documented app content
issues earlier passes report.
