# M2 web-target spike — findings

Run 2026-09-04/05 on the Windows build machine, against `apps/stingstream` (the vendored
Streamyfin subtree). Merge into `docs/ARCHITECTURE.md` as appropriate; kept separate here so the
mesh/server agents' edits to that file do not collide.

---

## Decision line

**Web target: VIABLE.**

`npx expo export --platform web` succeeds, the exported static bundle boots in a browser, logs into
a real Jellyfin server, browses the library, opens an item and plays video — both **direct play**
(`<video src>`) and **HLS transcode** (`hls.js`) — with the Android and Android TV JS bundles still
building unchanged from the same tree. The caveats below are real and some are substantial, but
none of them is a fundamental blocker, and none of them requires abandoning the "one UI" approach
for Capacitor.

---

## 1. What "no web support" actually meant

M0 recorded that `react-dom` and `react-native-web` were absent and no web config existed. That
was accurate but understated the starting point. Three separate classes of problem had to be
cleared before a single pixel rendered:

1. **Missing dependencies / config** — the easy part, one `expo install` and ten lines of
   `app.json`.
2. **Modules that will not *bundle* for web** — Metro refuses to resolve them at all, so
   `expo export` fails outright. Three of these.
3. **Modules that bundle but throw at *import* time** — `requireNativeModule` /
   `requireNativeView` evaluated at module scope. These are worse than class 2 because the export
   *succeeds* and the app is simply a blank page. Four of these, each found only by loading the
   bundle in a browser and reading the stack out of an unminified build.

Class 3 is the reason a "does it export?" check is not a sufficient gate, and why the browser
verification below matters.

### Blocker found first: the `utils/jellyseerr` submodule was never initialized

Not a web problem at all — a **vendoring gap that breaks every platform**. `apps/stingstream` has
its own `.gitmodules` mapping `utils/jellyseerr` → `https://github.com/herrrta/jellyseerr` (branch
`models`), and `git subtree add` does not initialize submodules. The directory was empty, so
`@/utils/jellyseerr/server/constants/discover` (and ~30 sibling imports from the Jellyseerr
screens) could not resolve, and **no** bundle could be built — web, Android or TV.

Resolved locally with a shallow clone into place:

```
git clone --depth 1 -b models https://github.com/herrrta/jellyseerr apps/stingstream/utils/jellyseerr
```

**Needs Dan's decision:** the repo should either vendor this as a second subtree (consistent with
how everything else is vendored, and it is only ~1 MB of TypeScript models), or CI and every dev
setup must run the app's own `submodule-reload` script. Right now a fresh clone of StingStream
cannot build the app. Note also that `tsconfig.json` excludes `utils/jellyseerr/**/*` but TypeScript
still compiles it transitively through the app's imports, so it contributes ~60 pre-existing type
errors (missing `@server/*` path mappings, `strictPropertyInitialization` on TypeORM entities);
`scripts/typecheck.ts` presumably filters these.

---

## 2. Changes made

All under `apps/stingstream/**`. **No existing app source file was edited** — the entire web target
is additive: new `.web.*` siblings, a new `lib/platform/` shim layer, a Metro resolver hook that is
a no-op unless `platform === "web"`, and config.

| File | Change |
| --- | --- |
| `package.json` / `bun.lock` | `+react-dom@19.2.3`, `+react-native-web@^0.21.2`, `+hls.js@^1.6.14`. `@expo/metro-runtime` was already present. |
| `app.json` | `platforms: ["ios","android","web"]` and a `web` block: `bundler: metro`, `output: single`, favicon, name, theme colors. |
| `metro.config.js` | `config.resolver.resolveRequest` hook that redirects a fixed map of native-only packages to `lib/platform/web-stubs/` **only** when `platform === "web"`; every other platform falls through to the previous resolver untouched. |
| `index.web.ts` *(new)* | Web entry. Metro resolves the package `main` (`./index`) with platform extensions, so this replaces `index.ts` on web and the native entry is byte-identical to before. Loads polyfills first and skips `TrackPlayer.registerPlaybackService`. |
| `lib/platform/web-polyfills.ts` *(new)* | Patches `Appearance.setColorScheme` (see below). |
| `lib/platform/web-stubs/*` *(new)* | Six stub modules; table in §3. |
| `modules/mpv-player/src/MpvPlayerView.web.tsx` | **Rewritten.** Upstream shipped a placeholder that rendered the stream URL in an `<iframe>`. Now a real `<video>` + `hls.js` player implementing the full `MpvPlayerViewRef` contract. |
| `modules/exoplayer-player/src/ExoPlayerView.web.tsx` *(new)* | Re-exports the web MPV view, so the Android-TV "use ExoPlayer" setting degrades to the same `<video>` backend instead of crashing on `requireNativeView("ExoPlayer")`. |
| `modules/background-downloader/src/BackgroundDownloaderModule.web.ts` *(new)* | Inert downloader; the real one is a module-scope `requireNativeModule`. |
| `tsconfig.json` | `include` gains `lib/**/*` so the shim layer is typechecked. |
| `.gitignore` | ignores `dist-*/` (side-by-side export dirs) and `yarn.lock` (bun.lock stays the lockfile of record). |

Design note on the two mechanisms: `.web.tsx` siblings are used wherever the file is *ours*
(`modules/**`), because that is the idiomatic Expo pattern and upstream already uses it. The Metro
resolver map is used for *third-party* packages, because the alternative — editing the app's
`Platform.isTV ? null : require(...)` guards to also test for web — would mean touching iOS/tvOS
code paths for a web-only reason, which is exactly what "native behaviour unchanged" forbids.

---

## 3. Every shimmed module, and why

### 3a. Would not bundle (Metro resolution failure — `expo export` fails)

| Module | Failure | Shim |
| --- | --- | --- |
| `react-native-track-player` | Git dependency (`lovegaoshi/…#APM`). Its `main` is `lib/src/index.js`, a build output produced by its `prepare` script. Native is fine because Metro reads its `react-native: "src/index"` field; **web's `resolverMainFields` has no `react-native` entry**, so it falls to the missing `main`. | `lib/platform/web-stubs/react-native-track-player.ts` — full enum/hook/command surface, every command an inert promise, hooks report a stopped player. Background/queued music playback is not available on web. |
| `@bottom-tabs/react-navigation` | Renders the *platform-native* tab bar; `react-native-bottom-tabs` imports `react-native/Libraries/Utilities/codegenNativeComponent`, which Metro refuses on web ("Importing react-native internals is not supported on web"). | `lib/platform/web-stubs/bottom-tabs-react-navigation.tsx` — `createNativeBottomTabNavigator()` backed by Expo Router's bundled JS bottom-tab navigator (`expo-router/js-tabs`, no new dependency) plus a custom tab bar. The custom bar is necessary because the two navigators disagree on options: the native one takes `tabBarIcon` returning `{ sfSymbol }` or a `require()`d image and hides items with `tabBarItemHidden`, neither of which the JS navigator understands. Rendering from `options.title` sidesteps that, and `app/(auth)/(tabs)/_layout.tsx` is used verbatim. |
| `react-native-google-cast` | Android/iOS Cast sender SDK; no web backend. | `lib/platform/web-stubs/react-native-google-cast.ts` — `CastButton` renders `null`, hooks report "no device / no session", `CastContext` resolves to `PlayServicesState.MISSING` so callers fall through to local playback. Cast affordances simply do not appear on web. |

### 3b. Bundled fine, then threw at import and blanked the page

| Module | Failure | Shim |
| --- | --- | --- |
| `@expo/ui/swift-ui` (+ `/modifiers`) | SwiftUI bridge; its barrel calls `requireNativeView("ExpoUI", …)` at module scope. Three components (`PlatformDropdown`, `search/DiscoverFilters`, `search/SearchTabButtons`) already lazy-require it — but behind `Platform.isTV`, which is **false** on web, so the require ran. | `lib/platform/web-stubs/expo-ui-swift-ui.js` — a `Proxy` returning null-rendering components for capitalised names and no-op functions for modifiers. Nothing is ever rendered: all three components branch on `Platform.OS === "ios"` before touching a SwiftUI element, so web falls through to their React Native / bottom-sheet path. The Proxy means a future `VStack`/`Picker` import will not regress this. |
| `expo-file-system` | **The single biggest surprise.** `expo-file-system@57`'s own web backend is hollow — `FileSystemFile` / `FileSystemDirectory` are empty classes with only a constructor — so the first `new Directory(Paths.document, …)` inside `DownloadProvider` throws `this.validatePath is not a function` during the first render. Sixteen app files use the modern `File`/`Directory`/`Paths` API. | `lib/platform/web-stubs/expo-file-system.ts` — directories are always creatable and always list empty (correct: nothing is downloaded on web); *text* files really work, persisted in `localStorage` under `stingstream:fs:` so small JSON bookkeeping survives a reload; binary payloads (`bytes`, `arrayBuffer`, streams, `upload`) reject with a clear "not available on web" error instead of a `TypeError`. |
| `expo-notifications` | Same `Platform.isTV` guard problem. `app/_layout.tsx` calls `getLastNotificationResponseAsync()`, which throws `UnavailabilityError` **synchronously inside a `useEffect`** — aborting the rest of that effect (deep-link handling, badge sync, listener registration). Not merely noisy. | `lib/platform/web-stubs/expo-notifications.ts` — permissions report `denied`, listeners inert, commands resolve. (expo-notifications does have partial web push support, but it needs a service worker and a VAPID subscription; local scheduled download-progress notifications are meaningless in a tab.) |
| `modules/exoplayer-player`, `modules/background-downloader` | Both call `requireNativeView` / `requireNativeModule` at module scope with no guard. | `.web.tsx` / `.web.ts` siblings (see §2). |

**Local Expo modules that needed nothing** — worth recording, because they are already written
correctly and are the model to copy: `system-volume`, `wifi-ssid`, `tv-recommendations`,
`top-shelf-cache`, `tv-user-profile`, `glass-poster`, `hero-carousel`, and
`mpv-player/NativePlayerPresentation` all wrap their `requireNativeModule` in a `Platform.OS`
check and/or `try/catch`, so they degrade to `null` on web by themselves. `utils/profiles/codecSupport.ts`
uses `requireOptionalNativeModule`, which is the right primitive throughout.

### 3c. React Native API gap

| API | Failure | Fix |
| --- | --- | --- |
| `Appearance.setColorScheme` | `app/_layout.tsx` pins the app to dark with `Appearance.setColorScheme("dark")`. react-native-web's `Appearance` is read-only (it only proxies `prefers-color-scheme`), so the call throws and takes down the root layout. | `lib/platform/web-polyfills.ts` makes it a real setter: records the forced scheme, notifies `addChangeListener` subscribers, and reflects it onto the document (`color-scheme` + `data-theme`) so browser-native UI matches the app chrome. |

---

## 4. The web player

`modules/mpv-player/src/MpvPlayerView.web.tsx` implements the whole `MpvPlayerViewRef` interface
against a `<video>` element, so `components/video-player/VideoPlayerView.tsx`, the controls overlay,
`NativePlayerProvider` and `direct-player.tsx` all work unmodified.

**Working:** HLS via `hls.js` (with native HLS on Safari/iOS, where `Hls.isSupported()` is false);
direct play via `video.src`; play / pause / seekTo / seekBy / speed / mute / position / duration;
progress + playback-state + load + error + tracks-ready events with `cacheSeconds` computed from
`video.buffered`; Picture-in-Picture through the browser PiP API; audio and subtitle track
enumeration and selection (from `hls.audioTracks` / `hls.subtitleTracks`, falling back to
`video.audioTracks` / `video.textTracks`); `addSubtitleFile` via a `<track>` element; zoom-to-fill
as `object-fit: cover`; `getTechnicalInfo` reporting dimensions, dropped frames, buffered seconds
and the current hls.js level's codecs.

**Deliberately inert (never throwing):** every MPV-specific subtitle *styling* control —
`setSubtitleStyle`, `setSubtitleAssOverride`, font size, background colour, border style, margins,
alignment, scale, delay. The browser renders WebVTT with its own UA styling and cannot render
ASS/SSA at all. The settings screens still open and behave; they just have no effect.

**Two caveats worth carrying into M3:**

1. **`source.headers` cannot reach a direct-play `<video>`.** `hls.js` applies them via `xhrSetup`
   for manifests and segments, but a plain `video.src` request carries no custom headers.
   Jellyfin's `api_key` query parameter is what authenticates direct play in a browser. **The
   HTTPS side door must therefore keep accepting query-string auth for web clients** — a
   header-only auth scheme would break direct play on web while leaving HLS working, which is a
   nasty failure mode to debug later.
2. **Sidecar subtitles must be requested as WebVTT** (`.../Subtitles/<i>/Stream.vtt`); a `<track>`
   element accepts nothing else. SRT/ASS URLs load and render nothing.

---

## 5. Verification

### Export

```
$ npx expo export --platform web
Web Bundled 4567ms index.web.ts (3565 modules)
Exported: dist
```

### Native unchanged

Both native JS bundles build from the same tree, and both entry on `index.ts` (not `index.web.ts`),
confirming the platform split resolves the way it should:

```
$ npx expo export --platform android              → Android Bundled 75613ms index.ts (4415 modules)
$ EXPO_TV=1 npx expo export --platform android    → Android Bundled 33519ms index.ts (4356 modules)
```

`npx tsc --noEmit` reports **0 errors** outside the vendored `utils/jellyseerr/**` submodule (which
carries ~60 pre-existing errors of its own), with `lib/**/*` added to the typechecked set.
`biome check` is clean on every new/changed file.

### Browser (Chromium via Playwright, production minified bundle served statically)

Server: **`https://demo.jellyfin.org/stable`**, user `demo`, empty password. It was up; no fallback
server was needed.

1. `/` redirects to `/login`; the login screen renders. **Zero console errors.**
2. Entering the server URL and pressing Connect resolves the server and shows "Log in to
   **Stable Demo**".
3. Logging in as `demo` lands on the home screen with **Continue watching**, **Recently added in
   Movies**, **Recently added in Shows** and **Suggested movies** all populated from the server,
   and the web tab bar (Home / Search / Favorites / Library).
4. The **Library** tab lists *Movies (11 Movies)*, *Shows (1 Series)*, *Music (13 Items)*.
5. Opening *Caminandes: Llama Drama* renders the full item page including media info parsed from
   the server (33.48 MB, 1920x1080, SDR, h264, 2.93 Mbps, 24 fps), cast & crew, similar items.
6. **Direct play.** Pressing Play routes to `/player/direct-player?...` and the `<video>` element
   reports:
   `src=https://demo.jellyfin.org/stable/Videos/…/stream?static=true&container=mov…`,
   `readyState 4`, `paused false`, `videoWidth 1920`, `videoHeight 1080`, `error null`.
   `currentTime` advanced **8.82 s → 11.83 s over a 3 s wall-clock wait** (+3.011 s) with 26.7 s
   buffered. The Streamyfin control overlay (skip ±10/30, pause, scrubber, title, elapsed and
   remaining) renders over it.
7. **HLS transcode.** Re-entering the player with `bitrateValue=250000` forces a transcode. The
   `<video>` src becomes a `blob:` MediaSource URL (i.e. `hls.js` is the engine), and the network
   log shows `master.m3u8` → `main.m3u8` → `hls1/main/0..12.ts` all `200`, with
   `TranscodeReasons=ContainerBitrateExceedsLimit`. Playback reached `currentTime 11.35 s`,
   `readyState 4`, 30 s buffered, **640x360** (correctly downscaled from 1920x1080), `error null`.

Screenshots in the run scratchpad: `stingstream-web-02-home.png`, `-03-item.png`,
`-04-playing.png` (direct play), `-05-hls.png` (transcode).

**Remaining console noise on the demo server (both benign):**
- `Streamyfin/config` → CORS error. That is the optional Streamyfin server-plugin endpoint, which
  the demo server does not have; Jellyfin's 404 path skips the CORS middleware so the browser
  reports it as a CORS failure rather than a 404. Every real Jellyfin API call was CORS-clean.
- `expo-keep-awake`: "The wake lock with tag ExpoKeepAwakeDefaultTag has not activated yet" —
  `deactivateKeepAwake` called before activation on the first playback-state event. Cosmetic.

---

## 6. Bundle size

Production export (`npx expo export --platform web`, minified, `output: "single"`):

| Artifact | Raw | gzip |
| --- | --- | --- |
| Main JS bundle | **11.7 MB** | **2.76 MB** |
| Secondary chunk | 46 KB | 15 KB |
| `Clipboard` chunk | 9.3 KB | — |
| `dist/assets/` (fonts, images) | 7.0 MB | — |
| `dist/` total | **19 MB** | — |

2.76 MB gzipped of JavaScript before first paint is **large** — jellyfin-web is roughly a third of
that. It is fine over a LAN and acceptable over the side door on a decent connection, but it is a
real cost for a phone on mobile data. Of the 7 MB of assets, ~5 MB is `@expo/vector-icons` shipping
*every* icon font (MaterialCommunityIcons alone is 1.3 MB) — the gateway should serve these with
long-lived cache headers, and trimming the icon set is easy future work. Route-level code splitting
would need `output: "static"`, which is a separate (and riskier) exercise — see §7.

---

## 7. Caveats and known gaps

Honest list. None blocks the decision; several will need attention during M2 proper.

1. **`output: "single"`, not `"static"`.** The SPA output was chosen because static rendering
   requires every route to render in Node, which the native-module-heavy route tree will not
   survive without more work. Consequence: one big bundle, no per-route splitting, no SSR/SEO.
   Fine for an authenticated app behind our own gateway.
2. **Downloads are stubbed out entirely.** The Downloads screen will render empty. Doing real
   offline on web would mean OPFS/IndexedDB + a service worker — a genuine project, not a shim.
3. **Music playback is stubbed out.** `MusicPlayerProvider` / `MusicPlaybackEngine` mount and
   render but do nothing. An `<audio>`-backed engine is a self-contained follow-up; the stub's
   surface is exactly what the app calls.
4. **Chromecast is absent on web.** Doing it properly means the Cast **Web Sender** API
   (`cast.framework`), a completely different surface from `react-native-google-cast`. Worth
   scheduling deliberately, since the architecture already promises casting via the side door.
5. **No ASS/SSA subtitles, no subtitle styling.** Structural: browsers render WebVTT only.
6. **Layout is phone-shaped.** react-native-web faithfully reproduces a portrait phone layout in a
   desktop browser — the player controls in particular stretch oddly on a wide viewport. This is a
   *design* task for M2's screens, not a platform limitation, but it is not free: the "one UI"
   promise needs responsive breakpoints that Streamyfin's components do not currently have.
7. **The `Platform.isTV`-as-a-guard idiom is a landmine.** The codebase's dominant pattern is
   `Platform.isTV ? null : require("native-thing")`. `Platform.isTV` is false on web, so *every one
   of those guards is a future web crash* the moment a new one is added. Recommend a lint rule, or
   a shared `isNativeOnly()` helper, before M2's screens are written.
8. **`@gorhom/bottom-sheet` is sluggish on web.** It works — the Quick Connect and welcome sheets
   opened, showed a live Quick Connect code from the server, and dismissed — but the animation runs
   long enough that the backdrop keeps intercepting clicks for a beat after "Done" is pressed.
9. **`react-native-mmkv` was not exercised beyond app boot.** It bundled and the app runs, so its
   web fallback is working, but persistence across reloads was not deliberately tested.
10. **Search / Favorites / settings screens were not exercised.** The gate was login → browse →
    play. Expect more class-3 import-time crashes on less-travelled screens; the `expo-ui` Proxy
    stub was written specifically to soften that.

---

## 8. Toolchain notes for whoever picks this up

- Install with **`bun install`** if you have it (`bun.lock` is the lockfile of record and CI checks
  it with `--frozen-lockfile`). `yarn install` works and is what was used here; it writes a
  `yarn.lock` which is now gitignored. `npm install` needs `--legacy-peer-deps` and still trips on
  `react-native-track-player`'s git `prepare` script.
- `bun` was installed for this run via `npm install -g bun` (v1.4.1) purely to regenerate
  `bun.lock` after adding the three dependencies. `bun install --frozen-lockfile --dry-run
  --ignore-scripts` passes.
- Debugging class-3 (import-time) failures: minified stacks are useless. Export with
  `--no-minify --output-dir dist-dbg`, serve it, read the line number out of the console error and
  `awk` that line range out of the bundle — the offending `requireNativeView("…")` call is right
  there. That loop found all four in a few minutes each.
