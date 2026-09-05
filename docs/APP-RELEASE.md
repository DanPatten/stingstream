# App release readiness (M5)

Signing, versioning, branding, ProGuard, offline downloads, Chromecast, DNS-rebinding detection,
and TV polish for `apps/stingstream`. Companion to `docs/APP-DEV.md` (building the app day to day)
and `docs/APP-MESH.md` (the embedded mesh this milestone builds several features on top of).

---

## 1. Identity

| | |
|---|---|
| `applicationId` (Android) | `org.stingstream.app` — was `com.fredrikburmester.streamyfin` |
| App name | `StingStream` |
| `version` (versionName) | `1.0.0` |
| `versionCode` | `1` |

**Versioning scheme.** There is no EAS remote-managed versioning here (`eas.json`'s
`appVersionSource: "remote"` / `autoIncrement` is Streamyfin's own EAS setup and is not used by
local Gradle builds at all). Both fields are plain values in `app.json`, bumped by hand:

- `versionCode` — a plain integer, incremented by 1 for every build that is ever installed on a
  device or uploaded anywhere, including internal test tracks. Two APKs can never share a
  `versionCode` once either has been installed — Android refuses to "downgrade" to an equal or
  lower one.
- `version` — semver, bumped for anything a person would call a new release (`1.1.0` for a feature
  milestone, `1.0.1` for a fix-only respin). Independent of `versionCode`'s arithmetic; several
  `versionCode`s can share one `version` during a milestone's internal iteration.

This is a deliberately simple starting scheme for M5. M8 ("Packaging, updates, hardening") is
where an actual release/update channel gets designed; nothing here should be read as final.

**Losing the keystore changes the app's identity on Google Play — read §2 before doing anything
else with it.**

---

## 2. Signing

### The keystore

A release keystore lives **outside this repository**, at

```
E:\Dan\Documents\Repos\.secrets\stingstream-release.keystore
E:\Dan\Documents\Repos\.secrets\stingstream-release.properties
```

Generated once for M5 with `keytool` (RSA 4096, PKCS12, 30-year validity, self-signed — a release
keystore's certificate does not need a real CA, only to never change):

```powershell
keytool -genkeypair -v `
  -keystore E:\Dan\Documents\Repos\.secrets\stingstream-release.keystore `
  -alias stingstream `
  -keyalg RSA -keysize 4096 `
  -validity 10957 `
  -storetype PKCS12 `
  -storepass <random> `
  -keypass <random>          # PKCS12 requires this to equal storepass; keytool enforces it
```

`stingstream-release.properties` next to it (forward slashes — see the `local.properties` gotcha
in `docs/APP-DEV.md`; the same Java `.properties` backslash-escaping bites this file too):

```properties
storeFile=E:/Dan/Documents/Repos/.secrets/stingstream-release.keystore
storePassword=<the store password>
keyAlias=stingstream
keyPassword=<the same password — see above>
```

**Dan owns this file and must back it up somewhere durable and private (a password manager, an
encrypted drive — not this repo, not a chat, not a ticket).** Neither the keystore nor the
properties file is committed; both are covered by `.gitignore` (`*.jks`/`*.p12`/`*.key` generally,
plus the properties file is simply never added). **If this keystore is lost, StingStream cannot
ever update the same Google Play listing again** — Play permanently binds a listing's identity to
the certificate that first uploaded it (or to Play App Signing's own key, if enrolled — see §7,
which changes what "losing it" means but not that losing the *upload* key is still a real
incident). A new keystore means a new `applicationId` or a new listing from scratch, existing
users cannot upgrade in place, and there's no support path to fix it after the fact.

### How the build actually gets signed

`android/` is gitignored and regenerated wholesale by `expo prebuild --clean`
(`docs/CONTRIBUTING.md` §3), so a signing config cannot live as a hand-edited line in
`android/app/build.gradle` — it would be wiped on the next prebuild. `plugins/withReleaseSigning.ts`
injects it instead, every time, the same way every other Android customization in this fork is
(see the rest of `plugins/`).

The injected Groovy reads `STINGSTREAM_KEYSTORE_PROPERTIES` (an environment variable naming the
properties file above) **at Gradle configuration time**, not at `expo prebuild` time — so the same
generated `android/` project signs correctly whether or not the variable happens to be set for a
particular Gradle invocation:

- **Set, and the file exists:** the release build type gets a real `signingConfigs.release` built
  from the properties file, and the log line `StingStream: release build signed with ...` says so.
- **Set, but the file is missing, or unset entirely:** the release build type's `signingConfig` is
  explicitly cleared (not left at the upstream template's own default of
  `signingConfigs.debug`), so the output is a genuinely **unsigned** APK/AAB — not debug-signed,
  which would be silently misleading about what it is. A warning line says why. This is what
  `.github/workflows/app.yml`'s unsigned-release CI job relies on: it runs with no keystore
  configured at all and gets an honestly-unsigned artifact to sanity-check the build itself.

### Building

```powershell
powershell -File apps/stingstream/scripts/build-release.ps1                          # phone + TV, signed
powershell -File apps/stingstream/scripts/build-release.ps1 -Variant phone
powershell -File apps/stingstream/scripts/build-release.ps1 -Variant tv -SkipMesh    # mesh .so already current
```

Each variant is its own `expo prebuild --platform android --clean` (`EXPO_TV=0`/`1`) followed by
`gradlew assembleRelease bundleRelease`, because a phone and a TV build cannot share one generated
`android/` project. Outputs land in `apps/stingstream/release-builds/<variant>/`, timestamped, so
running both variants back to back never overwrites one with the other (unlike
`android/app/build/outputs/**` itself, which both variants share).

The script rebuilds the mesh's native library first (`scripts/build-mesh-android.ps1`) unless
`-SkipMesh` — see `docs/APP-MESH.md`. **This must be built from a `stingstream-mesh` (and
`stingstream-mesh-ffi`) checked out at or after commit `5617978`** (the gossip frame chunking
change) to interoperate with any node built from current master; an older `.so` still links and
says nothing, which is exactly the kind of mismatch a release build should not ship with.

### Release-only hard failure on a missing mesh library

Already built (not new to M5, kept here because it's exactly what a release-readiness milestone
needs to verify rather than reinvent): `modules/stingstream-mesh/android/build.gradle` checks, for
every `merge*JniLibFolders` Gradle task, whether `libstingstream_mesh_ffi.so` is present for at
least one ABI. Missing it is a **warning** on a debug build (the module still compiles from the
committed Kotlin bindings; the app runs with the mesh reporting `available:false`, exactly as on
web) and a **hard `GradleException`** on any task whose name contains "release", or when
`-PstingstreamMeshRequired=true` / `STINGSTREAM_MESH_REQUIRED=1` forces the same strictness on a
debug build. Shipping a release APK whose mesh silently does nothing is a materially worse failure
mode than a build error.

---

## 3. Branding

A simple "SS" monogram — deliberately not a full illustration, per the brief ("a simple, tasteful
wordmark; keep the existing Streamyfin asset pipeline"). `scripts/generate-brand-assets.ps1`
regenerates it with `System.Drawing` (GDI+, built into Windows), writing over the same file paths
Streamyfin's own pipeline already used — `app.json`'s icon/adaptive-icon/splash/notification
references are all unchanged, only the image contents are:

```
assets/images/icon.png                 1024x1024  combined icon (web favicon, non-adaptive fallback)
assets/images/icon-android-plain.png   1024x1024  Android adaptive icon FOREGROUND
assets/images/icon-android-themed.png  1024x1024  Android 13+ monochrome themed icon (pure white)
assets/images/icon-ios-plain.png       1024x1024  splash-screen logo (shared cross-platform)
assets/images/notification.png         96x96      Android status-bar notification icon
```

Dan can swap in real artwork any time by replacing these files (or editing/re-running the
generator script) and re-running `expo prebuild` — nothing else references them by content.

**iOS-specific assets** (`icon-ios-liquid-glass.icon`, `icon-tvos-*`) are untouched. iOS and Apple
tvOS are out of scope entirely for this milestone (and until Dan says otherwise per
`docs/ARCHITECTURE.md`) — StingStream's Android TV target is Google's Android TV, a completely
different codebase path in this fork from Apple's tvOS, and none of the tvOS icon plumbing is
exercised by anything M5 built or tested.

**Web manifest** (`app.json`'s `expo.web.name`/`shortName`/theme colors) already said "StingStream"
before this milestone — only the native app name and the actual icon pixels needed catching up.

### Fork hygiene that came along with branding

Two things a "this is now StingStream's own release, not Streamyfin's" pass turned up and fixed,
neither of which is icon-shaped but both of which belong in the same category:

- **`google-services.json` removed from `app.json`'s Android config.** The committed file's
  `package_name` is `com.fredrikburmester.streamyfin` — building under the new `applicationId`
  with it still referenced fails outright (the Google Services Gradle plugin validates the
  package name matches). Push notifications need Dan's own Firebase project registered for
  `org.stingstream.app` before that comes back; nothing else in the app depends on it. The file
  itself is left in the tree (harmless, unreferenced) rather than deleted, since it is upstream
  Streamyfin's own vendored artifact.
- **Sentry disabled by default for production builds** (`.env.production`:
  `EXPO_PUBLIC_SENTRY_DSN=`, empty). `utils/sentry.ts` falls back to a DSN for upstream
  Streamyfin's own Sentry org ("streamyfin", project "react-native") when this is unset — a
  StingStream release must not silently report its crashes there. That file's own comment already
  anticipated a fork needing this override; M5 just set it. Dan can point it at his own Sentry
  project by setting a real DSN in `.env.production` (or `EXPO_PUBLIC_SENTRY_DSN` in the
  environment at build time).
- **Removed `owner`/`extra.eas.projectId`/`updates.url`** from `app.json` — all three named
  Streamyfin's own EAS project, which this build path never uses (local Gradle only, `eas.json` is
  vestigial from upstream). Nothing currently depends on `expo-updates` at runtime, so removing
  `updates` is inert rather than disabling a feature that worked.

---

## 4. ProGuard / R8

`expo-build-properties`' Android block now sets `enableMinifyInReleaseBuilds` and
`enableShrinkResourcesInReleaseBuilds`, with `extraProguardRules` covering what the fork adds on
top of whatever upstream Streamyfin's own dependencies already ship (most third-party AARs bundle
their own `consumer-proguard-rules.pro`, applied automatically — these rules are for the pieces
that do not, or where it seemed cheap enough to be safe rather than assume):

- **JNA** (`com.sun.jna.**`) and **uniffi's generated Kotlin bindings**
  (`uniffi.stingstream_mesh_ffi.**`) — both resolve classes, fields and methods by name at
  runtime; R8 has no way to know that and will rename or strip them with no build error, just a
  broken mesh at runtime.
- **The mesh's Expo module** (`expo.modules.stingstreammesh.**`) — not reflection-sensitive today,
  kept for safety since its native-library-load failure path is exactly the code the release-only
  hard-failure check above (§2) depends on behaving identically to debug.
- **libmpv's JNI bridge** (`dev.jdtech.mpv.**`, the Findroid `MPVLib` `modules/mpv-player` wraps) —
  harmless if redundant with that library's own bundled rules, not harmless if it turns out not to
  have any.
- A blanket `-keepclasseswithmembernames,includedescriptorclasses class * { native <methods>; }`
  for any other JNI-backed class app-wide.

**Not independently verified against a real device yet** — see §11 (what's verified). If a release
build installs but something native breaks that a debug build does not, R8 stripping something it
should have kept is the first thing to suspect; `-printusage`/`-printseeds` output
(`android/app/build/outputs/mapping/release/`) is where to look.

---

## 5. QuickConnect across the mesh

**Already implemented — no app code changed for this.** Streamyfin already ships both halves:

- **TV → phone approval:** `TVAddUserForm`'s "Quick Connect" action calls
  `JellyfinProvider`'s `initiateQuickConnect()`, which POSTs `${api.basePath}/QuickConnect/Initiate`
  and shows the returned code (`QuickConnectCodeModal`), then polls
  `${api.basePath}/QuickConnect/Connect?Secret=...` until authorized.
- **Phone approval:** `components/settings/QuickConnect.tsx`, reached from Settings, takes a typed
  or pasted code and calls the Jellyfin SDK's `authorizeQuickConnect`. It already exists — this
  milestone's "add the approve screen on the phone if missing" turned out to be already present.

Both go through `api.basePath`, which for this app is always the StingStream node's own gateway
URL (`http://<host>:8790/jellyfin`) — never a direct Jellyfin address — so both flows are already
routed through the gateway's `/jellyfin/*` passthrough with no StingStream-specific wiring needed.
QuickConnect's `Initiate`/`Connect` endpoints are intentionally unauthenticated in Jellyfin itself
(that's the whole point of the code-based pairing flow), and the gateway does not special-case
`/jellyfin/QuickConnect/*` — it is ordinary pass-through, like every other `/jellyfin/*` route.

**Verified:** §11.

---

## 6. Offline downloads, mesh-aware

Streamyfin's ffmpeg-based download path already understood federated (remote/mesh) media sources
before this milestone (`utils/jellyfin/media/getStreamUrl.ts`'s `getDownloadUrl`): a federated
item's `MediaSource.Path` is a `stingstream.local` URL, rewritten to the embedded mesh's loopback
port with `rewriteStreamUrlForMesh` when the device has joined the group, so the native downloader
already pulls bytes over the mesh rather than double-hopping through the home node's Jellyfin.

What M5 added is **source selection**: `getDownloadUrl` now calls
`GET /stingstream/api/v1/items/{id}/sources` (M4; see `docs/UI-API-GAPS.md`, "Closed in M4") before
rewriting, and prefers its best-scored **online** holder over whatever `MediaSource` PlaybackInfo
happened to return. That endpoint sees more than PlaybackInfo can: a title held locally on this
node (so never materialized as an alternate `MediaSource` — the local file already wins) still has
remote copies the group-wide scorer can see and a download can genuinely benefit from choosing.
`lib/stingstream/sources.ts` is the hand-written client (same reason as `lib/stingstream/mesh.ts`:
`packages/api-client`'s OpenAPI snapshot predates `ItemsController`). On any failure — an older
node, the mesh unreachable, nothing online — it falls back to PlaybackInfo's own choice; the
endpoint existed by the time this milestone reached it, so there is no TODO tied to its absence.

**Background continuation, pause/resume, storage location and quota:** all pre-existing Streamyfin
functionality (`modules/background-downloader`, `providers/Downloads/*`), not rebuilt here — a
native Android foreground service already carries the download across backgrounding, and the
Downloads screen already exposes pause/resume/remove and storage settings. M5's job was the
mesh-aware *source choice* specifically; the transport and lifecycle around it were already
release-ready.

**Verified:** §11 (download a federated episode, airplane mode, play it).

---

## 7. Chromecast over the HTTPS side door

**No Chromecast device is available to agents** (per the plan's standing constraints), so this is
unit-tested end to end and left as a manual checklist for Dan (below) rather than device-verified
here.

### What was built

`lib/stingstream/castStreamUrl.ts`. A federated `MediaSource.Path` is a `stingstream.local` mesh
URL, and **neither the raw form nor the loopback rewrite the native player uses** can ever be
handed to a Chromecast receiver — a receiver is a different physical device and can never reach
this phone's `stingstream.local` marker or its `127.0.0.1`. Casting a federated item therefore
needs a URL a receiver can actually resolve: the source node's own HTTPS side door.

`resolveCastStreamUrl`:

1. Parses `{group, item_key, node}` out of the federated path.
2. Looks for that node's `SideDoor` record, in order: the home node's own mesh peers
   (`GET /stingstream/api/v1/mesh/peers`) or status (when the source node is the home node itself),
   then the coordinator's public discovery record (`GET /node/v1/{node}`) as a fallback that works
   even against a Core build that does not carry the `SideDoor` field yet.
3. Races `lan`/`pub`/`relay` candidates with `lib/stingstream/sidedoor.ts` — M3d's helper, reused
   exactly as built, not rewritten.
4. Falls back to the home node's own `/stream/<group>/<item_key>/<node>` gateway proxy (deliberately
   unauthenticated — `docs/MESH.md` §5 — precisely so a cast receiver or a browser can reach it)
   when no side door exists at all. **This is the zero-server default working as intended**, not a
   broken state: casting from home with no coordinator configured always lands here, one extra hop
   through the home node instead of zero.

Wired into `components/PlayButton.tsx`'s existing Chromecast branch: after `getStreamUrl` returns
(as it always did), a federated `MediaSource` gets its `contentUrl` resolved through the side door
before `loadMedia`; an ordinary local item is completely unaffected (the resolver returns `null`
immediately for a non-federated path, so the existing behavior is the only behavior for the
overwhelming majority of casts).

Also fixed on the way: `lib/stingstream/mesh.ts` declared `MeshNodePeer.sideDoor` but never
decoded it — `toPeer` had no mapping for it at all, so a cast sender racing a peer's side door
always fell through to the slower discovery-record path. See the M5 commit that split
`lib/stingstream/mesh.ts` into a pure fetch layer (`meshApi.ts`) and a React Query layer, done so
`castStreamUrl.ts` and its tests never have to load `providers/JellyfinProvider`'s import graph
(which `bun:test` cannot load) just to make two fetch calls.

### Test coverage

`lib/stingstream/castStreamUrl.test.ts` — parsing, both `SideDoor` sources, the discovery-record
fallback (with a real hex→z32 conversion), and every fallback-to-home path (no record, race fails,
network down). `lib/stingstream/sidedoor.test.ts` (M3d's own, unmodified) covers the racing logic
this reuses.

### Manual checklist for Dan (no agent can run this)

Needs: a Chromecast (or a TV/dongle with Google Cast built in) on the same network as a StingStream
node, and — for the "away" cases — a second network (phone on cellular, or a friend's Wi-Fi) plus a
node with a coordinator configured (`docs/SIDEDOOR.md`; the Railway fallback has no side door until
Dan supplies a Cloudflare DNS token — see that document's §8).

- [ ] **Local item, home network.** Cast a normal (non-federated) file. Should be unaffected by
      anything in this milestone — sanity check that casting itself still works.
- [ ] **Federated item, home network, no coordinator on the group.** Cast a title held by another
      node in the same group. Expect: plays, and (from a debug build) logcat/console shows
      `via: "home"` — the home node's gateway is proxying `/stream/*`. No certificate/padlock is
      relevant here since it's plain HTTP on the LAN gateway port.
- [ ] **Federated item, a group with a coordinator, home network.** Same cast. Expect
      `via: "sidedoor"`, `kind: "lan"` — the source node's own `lan.<nodeid>.direct.<host>`
      candidate should win the race, with a real TLS handshake (no certificate warning if the
      coordinator's CA is production Let's Encrypt; a browser-style warning is expected and fine if
      the node is still on `staging`, per `docs/SIDEDOOR.md` §6).
- [ ] **Federated item, phone away from home (cellular), coordinator with a working side door.**
      Expect `kind: "pub"` (or `"relay"` if the source node's direct reachability probe reports
      `blocked`) — no certificate warning either way if in production mode.
- [ ] **Subtitles.** If the federated title has external subtitles, confirm they still render on
      the receiver (unrelated to the side-door change, but worth confirming nothing about the URL
      swap broke the sidecar-VTT path in `PlayButton.tsx`).
- [ ] **A cast started, then the phone locks/backgrounds.** Confirm playback continues on the
      receiver (Chromecast sessions are receiver-driven; this should already work and is a sanity
      check, not new behavior).

Report back what actually happened for each — especially which `kind` won each race — since that's
the one thing an agent cannot observe without real hardware.

---

## 8. DNS-rebinding detection

`components/stingstream/node/SideDoorSection.tsx`, on **Settings → Node status** (phone/web; hidden
on TV along with the rest of that screen, per `docs/UI.md`'s existing rule for management screens).

Some routers (OpenWrt's dnsmasq, pfSense, Fritz!Box) refuse to answer a public DNS name with a
private address, which breaks the `lan.<nodeid>` side-door candidate specifically. Ordinary side-door
racing (`castStreamUrl.ts`, the web bundle) only ever surfaces this when the plain-HTTP LAN fallback
actually **wins** a race — which it will not when `pub` or `relay` also happen to work, so a user
behind a rebinding router could go months without ever seeing the warning even though every LAN
connection is needlessly leaving the LAN. The Node status section instead runs a dedicated test
that probes every candidate — `lan`, `pub`, `relay`, and the plain-HTTP LAN fallback — independently,
via `lib/stingstream/sidedoor.ts`'s `probeCandidate`/`diagnoseRebinding` (reused as-is), so the
diagnosis is visible regardless of which candidate a real connection would end up using. When
rebinding is detected it shows the one-line fix and the plain-HTTP fallback URL:

> Your router refuses to answer this node's LAN hostname with its private address (DNS rebinding
> protection), so this connection is plain HTTP and not encrypted. To fix it, allow the domain in
> your router's DNS settings.

This is the same warning text the web bundle already shows for the same condition
(`REBINDING_WARNING` in `sidedoor.ts`) — one message, reused everywhere it applies, per the
milestone brief ("web bundle and app").

---

## 9. TV ten-foot polish

Most of this was already in place from M2/M3c (D-pad focus across browse/details/player, the Group
screens' TV-specific paste/type join flow, `hasTVPreferredFocus` on the primary action in
create/join). What M5 specifically checked and adds:

- **QuickConnect on TV**: the TV side is `initiateQuickConnect` + `TVAddUserForm`/`TVQRCodeDisplay`
  showing the code — already built, already TV-native UI (no phone-style approval screen on TV,
  which is correct: TV *shows* a code, phone *approves* it, per the milestone brief).
- **Player source pill** (direct/relayed/home-node fallback): also already built —
  `providers/MeshProvider.tsx`'s `useMeshSourceStatus`, rendered in
  `components/video-player/controls/TechnicalInfoOverlay.tsx`. Nothing to add; verified it reads
  correctly against a federated source (§11).
- **"Play from…" chooser** for a federated item's multiple `MediaSource`s: also already built,
  via the existing `MediaSourceButton`/`MediaSourceSelector` components (used pre-play and for
  downloads) — `MediaSource`s for a federated title are already in PlaybackInfo's scored order
  (M4), so the existing chooser already reflects it with no changes needed. **TODO, not built**:
  surfacing `stingstream:file_hash` explicitly in that chooser's labels (e.g. a "same file, another
  copy" badge for two sources sharing a hash) — the data is present in PlaybackInfo's per-source
  ETag and in `GET /items/{id}/sources`'s `fileHash` field, but no UI reads it yet. Left as a TODO
  rather than built here because it is a genuinely separate, smaller feature from "the chooser
  exists and shows the right order," which is what the milestone asked to verify first.
- **Node status / management screens stay hidden on TV** — unchanged; this was already the M2 rule
  and nothing in M5 needed to touch it (Node status, where the new DNS-rebinding section lives, is
  itself one of the screens that rule already hides).

---

## 10. CI

`.github/workflows/app.yml` — additive jobs (see the workflow file itself for the exact matrix):
unsigned release variants for both phone and TV (no `STINGSTREAM_KEYSTORE_PROPERTIES` set, so
`plugins/withReleaseSigning.ts`'s own fallback produces genuinely unsigned APKs — §2), plus running
the new unit tests (`lib/stingstream/castStreamUrl.test.ts`,
`utils/jellyfin/media/getStreamUrl.test.ts`'s new federated-download cases, and the `mesh.ts`/
`meshApi.ts` split's existing coverage) alongside the app's existing `bun run test` job.

---

## 11. Verification

*(Filled in as each check actually runs against a real node and the two emulators — see the
tracking notes at the bottom of this section for what is still outstanding.)*

---

## 12. Play Console prerequisites (for M8)

Not this milestone's job to do, but flagged here since M5 is the first point release readiness
becomes concrete. Before an actual Play Store listing:

- **A Google Play Developer account** (Dan's own, one-time $25 registration) — none exists yet for
  StingStream.
- **Enroll in Play App Signing** at first upload. Play then holds the *app signing key* and Dan's
  local keystore (§2) becomes the *upload key* — losing the upload key is recoverable (Google's
  key-reset process, with identity verification) in a way losing an unenrolled key never was, and
  it's the default/recommended path for exactly that reason. Enroll before the first production
  upload; it cannot be added retroactively to an already-published unenrolled app.
- **Store listing assets**: a feature graphic, phone/tablet/TV screenshots (Android TV listings
  need their own TV-shaped screenshots and a TV banner, separate from phone assets), a short and
  full description, and a privacy policy URL (required even for a self-hosted app with no
  StingStream-run backend, since the app itself handles user credentials and media).
- **Content rating questionnaire** and **Data safety section** — StingStream talks to a
  user-supplied home node and, for the fallback coordinator, to Dan's own Railway instance
  (rendezvous/side-door metadata only, per `docs/ARCHITECTURE.md`'s coordinator design — no media
  content); the Data safety answers should reflect that distinction precisely; get it wrong once
  and it needs a review cycle to fix.
- **`org.stingstream.app` name availability on Play** — not yet checked; do this before assuming
  the identity is final. (`docs/ARCHITECTURE.md` already flags `.com`/`.net`/trademark status as
  unverified for the project name generally — the same caution applies to the Play package name.)
- **Android TV eligibility**: a TV listing needs a TV-specific APK/AAB variant to be present in the
  same release (this milestone's `-Variant tv` build) and the Play Console listing configured for
  the Android TV device category separately from phone/tablet.

None of this blocks M5's own acceptance criteria (signed APKs exist locally; the app works on the
emulators); it is here so M8 does not have to rediscover it from scratch.
