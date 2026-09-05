# StingStream — architecture

This is the living architecture document for StingStream, kept current as the project evolves. It
started as the approved M0-through-M8 plan and is updated in place as decisions are made,
milestones land, and facts change; treat it as the source of truth for *why* things are built the
way they are, not just *what* exists today.

**Companion documents.** This file is the wide view. Where a subsystem has grown its own reference,
that reference is the newer document and wins on detail:

| Document | Owns |
|---|---|
| [`docs/MESH.md`](MESH.md) | The mesh and the coordinator: wire protocol, invite format, gossip, the index schema, the local and peer APIs, the side door's coordinator half. |
| [`docs/APP-MESH.md`](APP-MESH.md) | The mesh embedded in the app: the FFI crate, the light-node rules, and the `stingstream.local` rewrite on native. |
| [`docs/M2-web-spike.md`](M2-web-spike.md) | Why the Expo web target works, what had to change to make it, and the traps (bun only, no yarn). |
| [`docs/APP-DEV.md`](APP-DEV.md) | Building and running the app: toolchains, bun, the TV variant, the emulator. |
| [`docs/UI.md`](UI.md) | The screens, their information architecture, and what each one calls. |
| [`docs/RUNNING.md`](RUNNING.md) | Running a node, running two, and the acceptance harnesses. |
| [`docs/PATCHES.md`](PATCHES.md) | Every line StingStream changes inside a vendored upstream, and why. |
| [`deploy/node/LAYOUT.md`](../deploy/node/LAYOUT.md) | The install tree every packaging target (installer, `.deb`, AppImage, Docker image) assembles, and exactly which `childdef.rs` function resolves each path. |
| [`docs/INSTALL.md`](INSTALL.md) | Installing a release on each platform: first run, ports, data locations, uninstalling. |
| [`docs/RELEASING.md`](RELEASING.md) | Versioning, cutting a release, what CI verifies where, the service-mode approach, the update check, and what still needs Dan (signing certificates, winget/Homebrew submission). |

## Context

Dan wants a single self-hosted media app, **StingStream**, that replaces the usual five-tool stack
(Jellyfin for playback, Sonarr and Radarr for grabbing, nzb360 for remote management, plus a
download client) with one install, one UI, and one login. Every member of a group pools their
libraries and downloads automatically. Playback picks the best source across the group. Nodes
reach each other peer-to-peer through NAT, falling back to an open-source relay anyone can host
and select by hostname.

**Name checks (2026-09-04):** `stingstream.org` unregistered (PIR RDAP), `github.com/stingstream`
free, no app, project or company called StingStream found on the web. `.com` and `.net` lookups
were inconclusive and a trademark search has not been done — both are manual to-dos before
registering anything.

**Pivot (2026-09-04, after M0 build/vendoring work landed):** the "merge many servers" role moved
from a Jellyswarrm-style reverse proxy to a **federated library built inside each node's own
Jellyfin**. Reasons: we ship the only client, so a Jellyfin-API-compatible proxy buys nothing; a
proxy must chase every Jellyfin release and rebuild WebSockets, SyncPlay and session features; and
cross-server account mapping disappears entirely when remote titles simply appear in your own
server's library. Details under "Federated library" below. Jellyswarrm stays vendored as a git
subtree — reference only, and at most a source for its Rust `jellyfin-api` client crate — and is
**not in the request path**; M8 will decide whether to drop the subtree entirely.

---

## Decisions locked in with Dan

| Topic | Decision |
|---|---|
| Sharing scope | Invite-based groups. Nothing leaves a group. A node can belong to several groups. No public directory. |
| Sharing mechanism | **Federated library inside Jellyfin.** Each node materializes the group index into its own Jellyfin as `.strm` + `.nfo` items in dedicated Shared libraries, enriched in-process by `StingStream.Core`. Replaces the Jellyswarrm proxy (decided 2026-09-04). Jellyswarrm stays vendored only for its Rust `jellyfin-api` crate and as reference; it is not in the request path and may be dropped. |
| Downloads | Usenet and torrents, both **embedded**. External clients still allowed for existing setups. |
| Platforms at launch | Web (served by every node), Android, **Google TV / Android TV**. **iOS skipped entirely for now** (Dan, 2026-09-04); Apple tvOS later. |
| UI | **One codebase for all of them.** Expo app forked from Streamyfin (which already has TV variants), also built to web. The Expo codebase keeps iOS buildable in principle, but no iOS work, builds or accounts until Dan says so. |
| Node roles | Full nodes on Windows/macOS/Linux/Docker. Phones and TVs are light nodes: stream, phones download for offline and optionally re-share what they hold. |
| Playback | Direct-play the original over the mesh into MPV. Transcode only as a bandwidth fallback (home node first, source-side HLS later). |
| Fork depth | Trackable forks as git subtrees in one monorepo. Minimal patches, pull upstream for a year or two, then cut the cord. |
| Arr merge | One service from the user's view, shared config, separate Radarr and Sonarr cores. Sonarr from `v5-develop` (.NET 10), Radarr from `develop` (.NET 8). |
| Identity | Username + password on your **home node only**. No accounts on other nodes and no cross-server mapping: group membership is node-to-node trust, and remote titles appear in your own server's library. |
| Replication | Single copy, stream from wherever it lives. Grabbers check the group index first. Any node can pin a library to mirror it. |
| Central server | **Zero-server by default** (Dan, 2026-09-04): a new group needs nothing anyone hosts — iroh's public relays and DNS discovery plus mainline-DHT discovery. **Fallback: a StingStream coordinator Dan hosts on Railway** (TCP-only: relay protocol over 443, rendezvous, side-door DNS and ACME via a DNS-provider API, reachability probe, SNI passthrough). **Anyone can override with their own server:** the Group screen has a coordinator picker — Default (public infrastructure + Dan's fallback) or a custom hostname — and the invite code carries the choice to every member. Their own server can be the same coordinator binary in Lite mode (one-click Railway template) or Full mode (VPS with UDP address discovery and an authoritative DNS zone). GitHub cannot relay traffic and only distributes images, releases and docs. |
| Remote web and cast | An **HTTPS side door** next to the mesh, adapted from Plex's remote-access design (Dan, 2026-09-04): coordinator-managed per-node hostnames (an IP-reflecting zone on a VPS, or provider-API records via Cloudflare on Railway), a per-node Let's Encrypt wildcard certificate whose private key never leaves the node, UPnP/NAT-PMP/PCP port mapping, a coordinator reachability probe, SNI passthrough through the coordinator when direct fails, and connection racing in the web client and cast sender. Requires a coordinator; not available in pure zero-server mode. |
| Roadmap features | Requests (Seerr-style), watch-together across the mesh, offline downloads, automatic subtitles, relay doubling as a storage node, Live TV/DVR passthrough. **Not** music/books, **not** a public directory. |

---

## Facts that constrain the design

Verified 2026-09-04 unless marked otherwise.

- **Jellyfin**: C#/.NET 10, ASP.NET. License is GPL-2.0-*or-later* per project lead (issue #8226,
  "effectively 2+"), though the vendored `LICENSE` file itself is plain GPL-2.0 text with no "or
  later" clause. `jellyfin-web` is TypeScript/Webpack/Vite, GPL-2.0. Jellyfin can be run with
  `--nowebclient` so we can serve our own UI. Jellyfin's federation feature request is five years
  old with nothing scheduled — part of why we build our own federated library rather than waiting
  on or extending upstream federation. **M0 finding:** requires .NET SDK `10.0.0` per `global.json`
  (`rollForward: latestMinor`); resolved by installing SDK `10.0.400` via winget (see "Milestones"
  → M0). Build result: **succeeded**, 215 warnings (pre-existing upstream code-analysis warnings,
  not introduced by us), 0 errors.
- **Remote-backed items in Jellyfin are proven.** The debrid ecosystem (Zurg, jf-resolve,
  JellyGrail, Jellyfin-Xtream-Library) runs large libraries where every item is a `.strm` file
  pointing at an HTTP URL, with `.nfo` sidecars for metadata. Jellyfin groups same-folder files
  named `Title (Year) - Label.ext` as **alternate versions** of one movie, which is how one title
  held by several nodes becomes one item with several MediaSources. Multi-version support for
  *episodes* **was verified in M3b and works**: two `.strm` files for one episode in one season
  folder become one Episode with two MediaSources. See "What M3b settled". The fallback the plan
  reserved (one best version per episode) is not needed. **JellyfinFederationPlugin** (C#, MIT, 71 stars, 8 commits) is a proof of concept of
  the same in-Jellyfin approach; useful as reference, too thin to fork.
- **Radarr / Sonarr**: .NET backends, React/TypeScript frontends, GPL-3.0. Both descend from
  NzbDrone and share identical `NzbDrone.*` namespaces and heavy static state, so they cannot
  share one process without AssemblyLoadContext isolation that would wreck upstream tracking.
  They run as child processes; the "one process" the user sees is the supervisor. Both treat
  `.strm` as a video extension, so federated pointer files must never be written into arr-managed
  folders. **M0 finding:** Radarr `develop` pins SDK `8.0.421`; resolved by installing SDK
  `8.0.424` via winget. Build result: **succeeded**, 0 warnings, 0 errors. Sonarr was first
  vendored from `develop` (the plan's originally-named branch, which does exist but is the
  end-of-life v4 line pinning SDK `6.0.405`), then **re-vendored from `v5-develop`**
  (upstream's actual default branch, v5 milestone in active development, pins SDK `10.0.400`) —
  see `docs/PATCHES.md`. Build result after re-vendoring: **succeeded**, 0 warnings, 0 errors.
- **nzb360**: proprietary, and removed from Google Play on 2026-08-13. Cannot be forked; UX
  reference only. LunaSea (open-source equivalent) archived April 2025.
- **Jellyswarrm** (vendored in M0, now reference only, not in the request path): Rust, Axum 0.8,
  SQLx/SQLite, reqwest, ships a `jellyfin-api` client crate. Its three crates
  (`jellyswarrm-proxy`, `jellyswarrm-macros`, `jellyfin-api`) each declare `license = "MIT OR
  Apache-2.0"` with real, filled-in `LICENSE-MIT`/`LICENSE-APACHE` files, while the top-level
  `LICENSE` is the *unfilled* GPL-2.0 (June 1991) FSF template (still containing literal
  `{{description}}`/`{{year}}`/`{{fullname}}` placeholders) and the README badge links
  specifically to the GPL-2.0-only "old-licenses" page. **Dan's decision:** treat it
  conservatively as GPL-2.0 despite the crate-level MIT/Apache-2.0 declaration; StingStream's own
  mesh crates stay GPL-2.0-or-later, valid under either reading. Recommended follow-up: ask
  upstream to clarify which license actually governs the project. Its ~51 MB of Git LFS dev
  fixtures (18 files under `dev/media/**`) are vendored as LFS pointer text (not the real media) —
  `git-lfs` wasn't installed at vendor time, so the `git subtree add` ran with LFS
  smudge/clean/process/required disabled; a root `.lfsconfig` fetch-excludes that path from
  ordinary LFS operations, and `tools/fetch-jellyswarrm-media.ps1` pulls the real content on
  demand (attribution required for two CC BY 3.0 fixtures — Big Buck Bunny, Sintel — if used
  beyond local dev; see `mesh/jellyswarrm/dev/MEDIA-LICENSES.md`). Its `ui` submodule
  (Jellyswarrm's own admin UI, a `jellyfin-web` checkout) is mapped `update = none` in the root
  `.gitmodules`, since `git subtree add`/`pull` never initializes submodules and we don't need
  that UI at all. **M0 build finding:** its `crates/jellyswarrm-proxy` needs
  `JELLYSWARRM_SKIP_UI=1` (skips the npm/yarn build of the un-initialized `ui/` submodule) *and*
  an empty `static/` directory at build time (its `#[derive(RustEmbed)] #[folder = "static/"]
  struct Asset;` needs the folder to exist for the derive macro to implement the `Embed` trait;
  missing it compiles `Asset` but omits `get()`). Neither is a source patch — both are documented
  build-invocation accommodations in `docs/PATCHES.md`, and CI creates the empty directory as an
  explicit step. Build result: **succeeded** (`cargo build`, ~4 min from cold), and `cargo test`
  passes cleanly — 235 unit/doc tests passed, 2 integration tests correctly `ignored` (they
  require Docker and the real LFS media fixtures, ignored by name:
  `requires Docker and the Git LFS media fixtures`).
- **iroh 1.0** (June 2026): Rust, QUIC, ~90% direct hole-punch rate, encrypted stateless relays,
  relay binary open source and self-hostable, MIT/Apache. FFI for Swift, Kotlin, Node, Python.
  `iroh-gossip` (topic pubsub) and `iroh-blobs` (BLAKE3-verified range transfer) are companion
  crates. `iroh-h3` exists for serving Axum over iroh.
- **iroh connectivity details**: iroh's `portmapper` crate already tries UPnP, NAT-PMP and PCP to
  raise direct-connect odds, and relay traffic rides TLS on TCP 443, so UDP-hostile networks still
  work through the relay. None of that helps a browser or a Chromecast receiver: they cannot speak
  iroh and will only trust a hostname with a publicly trusted certificate. That is what the HTTPS
  side door below exists for.
- **Streamyfin**: Expo + React Native, TypeScript, MPV via MPVKit, ffmpeg-based offline downloads,
  Seerr integration, iOS/Android/tvOS/Android TV (`:tv` build variants). MPL-2.0 (GPL-compatible),
  confirmed against `apps/stingstream/LICENSE.txt`. Vendored from `develop` (the plan's originally
  named branch, `master`, does not exist upstream at all — `develop` is the repository's actual
  default branch/`HEAD`). **M0 found web support entirely absent upstream:** `react-dom` and
  `react-native-web` are not dependencies at all, and neither `app.json` nor `app.config.ts`
  declares a `platforms` array or any web-related config — this is a from-scratch addition for the
  M2 spike, not a broken/partial one. Uses `bun` as its package manager (`bun.lock` committed).
  **M0 build finding:** `npm install` alone fails on a peer-dependency resolution error (the
  aliased `react-native-tvos` package vs. `react-native-reanimated`'s peer range; npm's resolver
  doesn't recognize the alias as satisfying the range, `bun`'s resolver does)`--legacy-peer-deps`
  fixes that. Deeper than that, `npm install --legacy-peer-deps` alone still fails: a git-sourced
  transitive dependency (`react-native-track-player@4.1.1`) has an npm `prepare` lifecycle script
  that shells out to `yarn build`, and `yarn` wasn't installed —
  `npm install --legacy-peer-deps --ignore-scripts` gets past it (1080 packages installed). Once
  `yarn` was installed via `corepack enable` (see "Milestones" → M0), plain `yarn install` was
  re-tested — see the M0 build report for the result. `npx expo export --platform web` fails
  immediately as expected: `CommandError: ... don't have the required dependencies installed ...
  Install react-dom@19.2.3, react-native-web@^0.21.2`. This is the concrete M2-spike starting
  point: it's not about native-module shimming yet, it's that web support was never wired in
  upstream at all.
- **Embedded download engines**: MonoTorrent 3.x (.NET, MIT, BitTorrent v2) for torrents.
  NZBGet fork `nzbgetcom/nzbget` (C++, GPL-2.0, maintained, prebuilt binaries for Windows, macOS,
  Linux incl. ARM) for full-to-disk usenet — not vendored as a subtree, fetched on demand by
  `third_party/nzbget/fetch-nzbget.ps1` (latest release checked during M0: v26.3, correctly
  preferring the non-debug release assets over nzbgetcom's much larger `-debug` builds). InfiniDysk
  / `nzbdav/nzbdav` (.NET 10, MIT, maintained) for optional stream-from-usenet mode via WebDAV.
  **M0 build finding, resolved:** its `RapidYencSharp` project has an MSBuild pre-build step
  (`scripts/ensure-rapidyenc-native.sh`) that downloads a native `rapidyenc` binary from a GitHub
  Releases asset (which 302-redirects to `release-assets.githubusercontent.com`). This first failed
  on this machine: the `curl` bundled with Git for Windows (7.49.1 / OpenSSL 1.0.2h, from 2016)
  couldn't complete the TLS handshake with that CDN host (`curl -v` showed a `TLS alert, Client
  hello` immediately after following the redirect, producing a 0-byte file that then failed to
  unzip) — confirmed as a `curl`-version issue, not network/disk, by fetching the identical URL
  successfully with PowerShell's `Invoke-WebRequest` (57,240 bytes, valid zip). Fixed by installing
  a modern `curl` (`cURL.cURL` via winget, 8.21.0) and putting its directory ahead of Git's bundled
  one on `PATH` for the build invocation only (no subtree patch). Build result: **succeeded**, 0
  warnings, 0 errors, rapidyenc native fetched and installed correctly.

**Licensing outcome**: everything is combinable. New StingStream code is GPL-3.0-or-later. The mesh
binary is GPL-2.0-or-later. Radarr/Sonarr/NZBGet stay in their own processes under their own
licenses.

**Resources and constraints (Dan, 2026-09-04):** a VPS is available for the relay and a
domain/subdomain can be delegated (so M3's real-NAT and side-door tests can run for real). No iOS,
no Apple or EAS accounts — no iOS work happens until Dan says otherwise. No physical Android TV,
Chromecast or iPhone available to agents: TV acceptance runs on the Android TV emulator, Chromecast
acceptance is written as a manual checklist handed back to Dan. Docker Desktop and a JDK 17 +
Android SDK are not yet installed on the M0 build machine; M3 and M2 install them respectively as
those milestones need them.

---

## Architecture

### One node = one install = five processes behind one door

```
                 ┌──────────────────────────────────────────────────────────┐
  App (web/      │  stingstream  (Rust)   port 8790                          │
  Android/TV) ─► │  ├─ gateway: serves web bundle, routes /jellyfin/* to the │
                 │  │   local Jellyfin and /stingstream/* to Core + mesh     │
                 │  ├─ mesh: iroh endpoint, groups, gossip index, /stream    │
                 │  │   endpoint with source scoring, HTTP-over-QUIC to peers│
                 │  └─ supervisor: spawns, monitors, restarts children       │
                 └───┬──────────────┬──────────────┬─────────────┬──────────┘
                     │ localhost    │              │             │
          ┌──────────▼──────────┐ ┌─▼──────┐ ┌─────▼─────┐ ┌────▼─────┐  ┌──────────────┐
          │ jellyfin (fork)     │ │ radarr │ │  sonarr   │ │  nzbget  │  │ infinidysk   │
          │ + StingStream.Core: │ │ (fork) │ │  (fork)   │ │ (binary) │  │ (optional)   │
          │   federated library,│ └────────┘ └───────────┘ └──────────┘  └──────────────┘
          │   PlaybackInfo hook,│
          │   Omniarr sync,     │
          │   MonoTorrent,      │
          │   inventory, hooks, │
          │   requests          │
          └─────────────────────┘
```

- **`stingstream`** (Rust, entry binary): the only exposed port. Children bind localhost on
  supervisor-assigned ports written to `$STINGSTREAM_DATA/runtime.json`. The app always talks to
  its **home node's own Jellyfin** through this gateway; there is no virtual or proxied Jellyfin.
- **`StingStream.Core`** (new .NET project inside the Jellyfin fork, registered in `Jellyfin.Server`
  startup): lives in Jellyfin's process to use `ILibraryManager`, the item repository and the
  PlaybackInfo pipeline for the federated library, and to reuse Jellyfin's auth for the StingStream
  API at `/stingstream/api/v1/*`.
- **Radarr / Sonarr forks**: aim for zero code patches. Supervisor pre-seeds `config.xml`
  (API key, port, bind address, UrlBase, auth method). Their UIs are simply not routed by the gateway.
- **Config sync ("Omniarr" — internal name only)**: one shared model (indexers, download clients,
  quality profiles, root folders, naming, notifications) pushed into both cores via their v3 APIs.
  Same pattern Prowlarr uses.
- **Downloaders**: MonoTorrent runs in-process behind a **qBittorrent-compatible API subset**
  (login, app/version, app/webapiVersion, torrents/info, add, delete, properties, files, setCategory)
  so the arr cores use it unmodified. NZBGet runs as a bundled child with its native API. InfiniDysk
  optional (SABnzbd-compatible API, streaming mode) — later milestone.

### Groups and identity

- **Node identity** = iroh keypair, persisted in `$STINGSTREAM_DATA/node.key`.
- **Group** = 32-byte group ID (also the gossip topic) + group secret + relay URL. The relay is a
  property of the group, so members auto-configure it from the invite.
- **Invite code** = base58(group ID, secret, inviter node address, relay URL). Joining requires the
  inviter (or any member) online in v1. Revocation in v1 = secret rotation; proper member revocation
  in M8.
- **Users** exist only on their home node as ordinary Jellyfin accounts. Group membership is
  node-to-node trust. A member's users see the whole group's content because their own Jellyfin
  contains it (see "Federated library" below). Per-user watched state, favourites and progress
  therefore live where they always did, on the home node, with no fan-out.
- **Content identity** = provider IDs (tmdb/tvdb/imdb + season/episode) for "same title", plus a
  BLAKE3 file hash computed on import for "same file". Both live in the inventory record.

### Inventory and group index

Each node's `StingStream.Core` publishes, per item it holds locally: `{node, item_key,
jellyfin_item_id, media summary (container, resolution, codecs, bitrate, size, duration, audio and
subtitle tracks), file_hash, metadata blob (title, year, overview, genres, people, ratings, runtime,
provider IDs, image URLs served over the mesh), updated_at}` plus a heartbeat `{max_direct_streams,
max_transcodes, active counts, free space}`. Mesh broadcasts signed snapshots + deltas over
`iroh-gossip` and keeps a SQLite `group_index`. Used for the federated library, grab dedupe, and
source selection.

### Federated library (the merge mechanism)

Each node turns the group index into real items in its **own** Jellyfin, so every native feature
works unchanged. Proven pattern from the debrid ecosystem; implemented in `StingStream.Core`
(`src/StingStream.Core/Federated/`, landed in M3b).

1. **Shared libraries.** Two Jellyfin libraries per node, `Shared Movies` and `Shared TV`, backed
   by `$STINGSTREAM_DATA/federated/{movies,tv}`. Internet metadata fetchers are off for them and
   the NFO reader is on. They are never arr root folders, since both arrs treat `.strm` as video.
2. **Materialization.** For every `item_key` in the group index that this node does **not** hold
   locally, Core writes the standard folder layout with one `.strm` per holding node and quality
   (`Title (Year) - <node-label> 1080p.strm`), a `.nfo` built from the source's metadata blob, and
   image files fetched from the source node over the mesh. Jellyfin's resolvers turn that into one
   movie or episode with alternate versions. Titles held locally are not materialized (the local
   file wins); their remote copies are still used for pin, dedupe and future failover.
3. **Enrichment in-process.** After the targeted refresh Core stamps MediaStreams and runtime on
   each version from the inventory record, so resolution and codec badges appear without probing.
4. **Lifecycle.** Index delta → write or remove pointer files → targeted library refresh. A peer
   going offline marks its versions unavailable (tag, greyed in the app) rather than deleting them;
   removal happens after a configurable grace period. When a local copy arrives (grab or pin) the
   pointer entry is removed.
5. **Stream URL.** Each `.strm` contains `https://stingstream.local/stream/<group>/<item_key>/<node>`.
   Core's PlaybackInfo hook returns the MediaSources ordered by score (next section). The native
   app rewrites `stingstream.local` to its own embedded mesh listener and MPV plays from there,
   dialing the source node directly over iroh: no double hop through the home node. Any client
   without a mesh (a browser, a cast receiver, a stock Jellyfin client) falls back to the home
   node's Jellyfin proxying the URL through the node's own mesh, or to the source node's HTTPS side
   door.

### Playback path

1. App asks its home node's Jellyfin for PlaybackInfo.
2. `StingStream.Core` looks up candidates for the item_key in `group_index` and scores them:
   connectivity (direct beats relayed, RTT from iroh path info) → measured throughput (rolling
   per-peer estimate) → quality fit against policy → source load.
3. Policy is a user setting: **Speed first** (default: best quality that fits bandwidth with margin)
   or **Quality first** (highest quality; transcode if it doesn't fit). PlaybackInfo returns the
   MediaSources in scored order; the app plays the first and offers "Play from…" for the rest.
4. Direct-play: file bytes flow source Jellyfin → source mesh → iroh (direct or relayed) → the
   app's own mesh → MPV (native, incl. TV). HTTP/1.1 range requests over a dedicated QUIC bidi
   stream per request, ALPN `stingstream/http/1`.
5. Fallback: the home node's Jellyfin transcodes the remote source (pulling the original over the
   mesh); source-side HLS via the source node's Jellyfin is a later refinement.
6. Failover: same file hash elsewhere → the mesh `/stream` endpoint resumes by byte offset on
   another holder transparently. Different file → the app restarts by timestamp on the next
   MediaSource.

#### The scoring formula, as built (M4)

Four components, each normalised to `0..1`, weighted by the viewer's policy:

| Component | How it is computed |
|---|---|
| `connectivity` | `0.7 × path + 0.3 × rtt`, where `path` is 1.0 direct, 0.9 mixed, 0.45 relay, 0.6 never-connected, and `rtt = 1 / (1 + ms/120)` |
| `throughput_fit` | `min(1, measured ÷ (bitrate × 1.25))`, or 0.5 when the link has never been measured |
| `quality` | `min(1, height ÷ 2160)`, or 0.4 when the holder published no dimensions |
| `headroom` | `free ÷ max_direct_streams` from the holder's heartbeat, or 0.5 when it advertises none |

| Policy | `connectivity` | `throughput_fit` | `quality` | `headroom` |
|---|---|---|---|---|
| **Speed first** (default) | 30 | 45 | 20 | 5 |
| **Quality first** | 20 | 15 | 60 | 5 |

Then two disqualifiers, applied as large negative offsets rather than as filters — a holder that
cannot serve still appears in "Play from…" *with a reason* instead of vanishing: a holder with no
heartbeat inside the peer timeout loses 10,000, and one already at its advertised
`max_direct_streams` loses 1,000.

Three deliberate choices in there:

- **An unmeasured link scores 0.5, not 1.0.** It should not beat a peer we have watched succeed, and
  it should not lose to one we have watched fail. Measurements come from real transfers: the mesh
  folds each completed range read into a per-peer EWMA (α = 0.4) and *discards* anything under
  256 KiB or 100 ms, because a 64 KiB seek that finished in 8 ms is arithmetically 65 Mbit/s and
  says nothing about whether a film will stream.
- **The 25% margin** is what makes "fits" mean fits: an average bitrate hides the peaks a
  variable-bitrate encode actually has to deliver on time.
- **The formula exists twice**, in `StingStream.Core/Playback/SourceScorer.cs` and in
  `mesh/crates/stingstream-mesh/src/score.rs`, with the same weights and the same test cases in both
  languages. That is a real cost, paid so that `?any=1` and mid-stream failover — moments with no
  Jellyfin in the loop — do not put a .NET round trip inside every seek.

#### Failover semantics (M4)

`/stream/{group}/{item_key}/{node}` returns a body that **survives its holder**. When the holder
fails mid-transfer, the mesh asks the next holder of the **same `file_hash`** for
`bytes=<what has already been delivered>-` and keeps yielding on the same HTTP response. The reader
sees one uninterrupted body, because the `ETag` is derived from the hash and both holders are
therefore serving the same representation by definition.

Three things count as "failed": an error on the body, a body that ends before its promised
`Content-Length`, and a body that produces nothing for `peer.stream_stall_secs` (15 by default). The
third is what makes failover *prompt*: a holder whose process is killed closes nothing at all, and
QUIC will not call that a failure until its own idle timeout, tens of seconds later — long after a
player has given up. A `503` from a saturated holder is handled before any bytes are committed, so
the client never sees it.

**A holder with a different encode is never used.** Resuming into different bytes at a byte offset
produces garbage. That case is a restart by timestamp on the next `MediaSource`, and it belongs to
the client: PlaybackInfo gives it the ordered list and each source's hash (as the `ETag`,
`W/"b3-<hash>"`), which is exactly enough to tell "the same bytes elsewhere, resume silently" from
"a different encode, restart at 00:41:12". The app half is M5's.

#### The transcode fix, and why it needed no encoder patch

Transcoding a federated source used to fail outright. The pointer's host is `stingstream.local`,
which resolves only inside Jellyfin's own `HttpClient` (`StingStreamLocalHandler`); ffmpeg does its
own DNS and never sees that handler.

`MediaSourceInfo` already carries `EncoderPath`/`EncoderProtocol`, and
`EncodingHelper.AttachMediaSourceInfo` already prefers them over `Path` — it is how Live TV hands the
encoder a local recording URL. So the source decorator fills them in with this node's own gateway,
`http://127.0.0.1:<gateway>/stream/<group>/<item_key>/<node>`, and every downstream line is
unmodified upstream code. The client still gets `stingstream.local`, which is what the native app
rewrites to its own embedded mesh.

The **trigger** is separate from the fix: when a source's bitrate exceeds what this node has
*measured* it can pull from that holder, the decorator clears `SupportsDirectPlay`, which is what
makes Jellyfin's own `StreamBuilder` return a transcode. It fires only on a link that has actually
been measured and measured short — transcoding on a guess spends the home node's CPU and the
viewer's quality for nothing. Under Speed first it should almost never fire, because the ranking has
already preferred a version that fits; under Quality first it is the mechanism by which "give me the
4K even if the link cannot carry it" is kept as a promise.

### Grab / add / request flow

1. User adds a title (or a member requests one) via the StingStream API.
2. `StingStream.Core` asks the mesh for `group_index` matches at acceptable quality.
3. Present → it is already in the Shared library; mark "available via group", optionally add to
   arr **unmonitored** for future upgrades. **No download.**
4. Absent → add to the fulfilling node's arr core (requester's home node by default; else a
   volunteer node with matching indexers and free space) as monitored → grab → embedded engine →
   import → arr webhook → Jellyfin refresh → inventory publish → materialized on every other node
   within seconds.
5. **Pin/mirror**: node fetches the file over iroh (resumable HTTP range) into its own root folder,
   imports it, removes its pointer entry, and the index now shows two copies.

**The verdict is persisted** (`library_state` in `core.db`), and that is not bookkeeping for its own
sake: the dedupe rule is the single most surprising thing StingStream does from outside. A user
presses Add and no download starts. Without a stored row saying "available via group, held by loft",
that is indistinguishable from a button that does not work.

"Acceptable quality" is compared against a **pixel floor** the caller passes
(`minimumHeight`, 0 by default meaning "anything the group has"), not against the arr's quality
profile. A profile is a cutoff and an upgrade policy expressed in release terms; the group index
holds pixels and a bitrate. Mapping one onto the other honestly needs the arr's own release parser,
which is not reachable from here — so this promises the smaller thing it can actually keep.

**Pin** goes through the mesh's own `/stream` endpoint rather than reaching into iroh directly,
which buys three things for free: the source is chosen by the same scorer playback uses, a holder
dying halfway is a transparent continuation from another holder of the same bytes, and a saturated
holder's `503` sends it elsewhere instead of stalling. The copy is verified against the BLAKE3 the
holder published before it is moved into place, and it resumes from a partial file across a restart
of the *pinning* node too.

The import is **place, then rescan**: the file is written straight into the arr's root folder under
the layout the arr itself would have produced, and the arr is then asked to rescan that one title.
The obvious alternative — stage it and call `DownloadedMoviesScan` — runs the arr's *release* parser
over a filename that was never a release, and it rejects what it cannot parse, including anything
that trips its sample-size check. A rescan of a title the arr already tracks has no such opinion. A
pin of something the arr has never heard of has nothing to rescan, and Jellyfin is asked directly
through the same targeted refresh the arr webhooks use.

A per-library **mirror** toggle (`federated.mirrorMovies` / `mirrorTv`) runs the same path in the
background for everything the group holds, stopping at a configurable free-space floor and running
at most `mirrorConcurrency` copies at once. Off by default, and it should stay off on a laptop: the
point of the federated library is that one copy is enough. It is for a seedbox or an always-on node
somebody wants to be the group's backstop.

### Coordinator (`stingstream-relay`) — one binary, three deployment modes

The coordinator is **optional infrastructure**. A group created with none works: iroh's public
relays carry the traffic, n0's DNS and the mainline DHT carry the discovery, and the invite code
carries the inviter's address so a join needs no lookup at all. One Rust binary (Docker image on
GHCR) covers the rest, with feature flags chosen by what the host can offer:

| Mode | Where | Provides | Cannot provide |
|---|---|---|---|
| **None (default)** | nobody | iroh public relays + n0 DNS discovery + mainline DHT | side door, rendezvous when the inviter is offline |
| **Lite (Dan's fallback)** | Railway, TCP only | relay protocol on 443 (HTTPS→WebSocket, so it works through Railway's proxy), rendezvous, reachability probe, SNI passthrough, side-door DNS records and ACME challenges published through a **DNS-provider API** (Cloudflare first, provider trait for others) | UDP address discovery (nodes get it from n0's relays), authoritative DNS |
| **Full** | a VPS with UDP | everything in Lite plus `iroh-dns-server` discovery, UDP 7842 address discovery, and the authoritative IP-reflecting `direct.<host>` zone with no provider dependency | — |

Dan's Railway instance is baked into the build as the default fallback coordinator:

```
https://stingstream-coordinator-production.up.railway.app
```

Deployed 2026-09-05 in M3a from `ghcr.io/danpatten/stingstream-coordinator:latest`. It is
`DEFAULT_FALLBACK_COORDINATOR` in `mesh/crates/stingstream-mesh/src/config.rs`, appended to every
group's relay map regardless of the group's own choice, and deliberately registered *without* QUIC
address discovery so iroh never picks it as a home relay — its jobs are rendezvous and the side
door, not carrying video. Relaying media through it is metered egress on Dan's bill, so it is
ranked below n0's public relays and a per-group bandwidth cap is configurable. Override it per
install with `STINGSTREAM_MESH_FALLBACK_COORDINATOR`; an explicitly empty value means "no
fallback", which is what the integration tests use.

Compose profile `storage-node` (Full mode) adds a StingStream node joined to the group, so the host
is also an always-on seedbox and cache. `docs/MESH.md` section 6 is the reference for the wire
protocol, the API and the hosting configuration; `deploy/coordinator/README.md` is the hosting
guide.

### HTTPS side door (browsers, Chromecast, TV web views, 443-only networks)

The mesh serves the native apps. Anything that cannot speak iroh QUIC or verify a node-key
certificate — a browser away from home, a Chromecast receiver, a TV web view, or any client on a
network that only passes TCP 443 — uses a second door that ends in the same gateway. Adapted from
the Plex remote-access design with one change: private keys never leave the node.

1. **Per-node hostnames.** Every node gets `lan.<nodeid>.direct.<host>`,
   `pub.<nodeid>.direct.<host>` and `relay.<nodeid>.direct.<host>`, where `<nodeid>` is the node id
   in z-base-32 (52 characters — the 64-character hex form does not fit in a DNS label). In **Full**
   mode the coordinator is authoritative for `direct.<host>` and answers IP-reflecting labels
   arithmetically (`192-168-1-5.<nodeid>.direct.<host>` → `192.168.1.5`, IPv6 with dashes likewise)
   with nothing to maintain and long TTLs. In **Lite** mode (Railway, no UDP, not authoritative) the
   coordinator publishes real A/AAAA records for the same three names through a `DnsProvider` —
   Cloudflare first, behind a trait — whenever a node reports an address change, using a
   zone-scoped token. **The hostnames are identical either way**, which is the point: a node, a
   browser and a cast receiver never need to know which kind of coordinator is behind them.
2. **Per-node wildcard certificate.** Each node generates its own key and a CSR for
   `*.<nodeid>.direct.<host>`, runs the ACME client itself (Let's Encrypt, DNS-01, Rust
   `instant-acme`), and asks the coordinator to publish the `_acme-challenge` TXT record through an
   endpoint only that node can write, with the request signed by its iroh key (the acme-dns
   pattern). The coordinator writes the record itself (Full) or through the provider API (Lite).
   Renewal at 60 days. The gateway serves the certificate with rustls on 8790 and, optionally, 443.
   The coordinator never holds a node's key.
3. **Port mapping.** The supervisor asks the router for a TCP mapping to the gateway via UPnP IGD,
   NAT-PMP or PCP, reusing iroh's `portmapper`. The result is shown on the Node status screen, with
   manual-rule instructions if all three fail.
4. **Reachability probe.** The node reports `{lan_ips, public_ip, mapped_port, cert_expiry}` to the
   coordinator, signed by its own iroh key so the claimed addresses cannot be altered in flight. The
   coordinator attempts a real TLS *handshake* to the public hostname — not a TCP connect, which a
   plain listener would pass — and records `direct_https: ok | blocked` in the node's discovery
   record, so clients learn the answer without first reaching the node. It deliberately does not
   validate the certificate: trust is the browser's job, and a node mid-renewal should not read as
   unreachable. A node may only ask about a hostname containing its own id, so the endpoint is not
   a port scanner with someone else's source address.
5. **Coordinator passthrough when direct fails** (CGNAT, no UPnP, 443-only networks). The
   coordinator's 443 listener reads the ClientHello by hand and dispatches by SNI: its own hostname
   terminates there and serves the relay and the API, and `relay.<nodeid>.direct.<host>` becomes a
   raw TCP tunnel over iroh to that node's gateway. TLS still terminates on the *node*, with the
   node's certificate, so the coordinator sees an SNI string and ciphertext. Same certificate, three
   hostnames. Only registered nodes are routable, and an unregistered id is refused identically to a
   stranger's name, so the router cannot be used as an open proxy.
6. **Connection racing.** The web bundle and the cast sender read the candidate hostnames from the
   discovery record — LAN, public, relay — open all of them with a short timeout, keep the first
   that completes a TLS handshake, and remember the winner per network. LAN wins at home, public
   wins away, relay wins on hostile networks.
7. **Chromecast.** The sender hands the receiver the raced HTTPS URL. Cast receivers resolve
   through Google's public DNS, which our authoritative zone answers, so even the LAN hostname works
   from a receiver.
8. **DNS rebinding protection.** Some routers (OpenWrt dnsmasq, pfSense, Fritz!Box) drop public DNS
   answers that point at private IPs. The web client detects this (LAN name fails while the LAN IP
   is reachable), shows the one-line fix — whitelist `direct.<host>` — and falls back to plain
   `http://<lan-ip>:8790` for LAN browsers with a visible warning.

Hosting needs, by mode. **Lite (Railway):** a service with the TCP proxy on 443, a domain whose
DNS lives at a supported provider (Cloudflare first) and a zone-scoped API token, and a Let's
Encrypt account for the coordinator's own name. **Full (VPS):** NS delegation of `direct.<host>` to
the box, UDP+TCP 53, TCP 443, UDP 7842, and the same Let's Encrypt account. The hosting guide covers
both. Let's Encrypt allows 50 new certificates per registered domain per week and exempts renewals,
so a friend-group coordinator is comfortable; Dan's shared fallback would request a rate-limit
increase or add ZeroSSL as a second CA once it passes that.

**Status.** Both halves shipped: the coordinator's in M3a, the node's in M3d. A node now runs its
own ACME client (`instant-acme`, DNS-01 through the coordinator's signed TXT endpoint) with the key
generated and kept on the node; the gateway serves that certificate with rustls and picks up a
renewal on the next handshake rather than on a restart; iroh's `portmapper` asks the router for a
TCP mapping and surfaces the manual rule when all three protocols fail; the node answers ALPN
`stingstream/tcp/1` so the coordinator's SNI passthrough has somewhere to land; and its candidate
hostnames ride the gossip heartbeat to every member. The web bundle races them.
`tools/e2e-sidedoor.ps1` proves the whole path — a real ACME order against a local Pebble, a real
wildcard certificate, a real TLS handshake against `pub.<nodeid>`, a real tunnel through the SNI
router, and the `blocked` case — on loopback, in about a minute and a half, on Windows and in CI.
**What has not happened is a certificate from real Let's Encrypt for a real domain**, because a
Lite-mode coordinator publishes every one of these names through a DNS provider and there is no
Cloudflare token yet; Dan's Railway coordinator therefore has no side door today and a node pointed
at it reports `state: "no_zone"` and carries on without one. Full mode needs no token at all.
`docs/SIDEDOOR.md` is the reference.

### The app (`apps/stingstream`)

Fork of Streamyfin. Targets web (react-native-web via Expo), Android, and Android TV / Google TV
(Streamyfin's existing `:tv` variant); iOS buildable in principle but no iOS work until Dan says
so, Apple tvOS later. Player abstraction: MPV on native and TV, `<video>` + hls.js on web. Server
URL is always the user's own node; the federated library makes the whole group appear in it. New
screens: **Manage** (movies/series wanted, calendar, queue, history), **Downloads**, **Server
settings** (indexers, engines, quality profiles, root folders, naming), **Group** (nodes, members,
invites, relay, storage), **Requests** (adapted from Streamyfin's Seerr screens), **Admin** (users,
libraries, scan, transcoding, logs), **Node status**. The TV build gets the browse/play/requests
surface with D-pad focus handling; management screens stay phone/web-only. Native builds embed an
iroh endpoint and rewrite `stingstream.local` stream URLs to it; the web bundle and the cast sender
use the HTTPS side door with connection racing. Stock jellyfin-web, Radarr, Sonarr and NZBGet UIs
are never the front door.

---

## Repository layout

```
StingStream/
├─ apps/stingstream/         # Expo app  (subtree: streamyfin/streamyfin, develop)  web + mobile + TV
├─ server/jellyfin/          # subtree: jellyfin/jellyfin  + src/StingStream.Core (new)
├─ server/radarr/            # subtree: Radarr/Radarr (develop)
├─ server/sonarr/            # subtree: Sonarr/Sonarr (v5-develop)
├─ server/infinidysk/        # subtree: nzbdav/nzbdav (optional usenet streaming)
├─ mesh/                     # Rust — TWO Cargo workspaces (see "Mesh workspace" below)
│  ├─ jellyswarrm/           # subtree: LLukas22/Jellyswarrm — reference only, not in the request
│  │                         #   path; at most a source for crates/jellyfin-api. Own workspace.
│  └─ crates/                # mesh/Cargo.toml is the OTHER workspace, for these three:
│     ├─ stingstream/        # entry binary: supervisor + gateway
│     ├─ stingstream-mesh/   # iroh transport, groups, gossip index, /stream endpoint + scoring
│     └─ stingstream-relay/  # relay + discovery + direct DNS zone + SNI router + storage-node profile
├─ packages/api-client/      # TS client generated from StingStream OpenAPI
├─ third_party/nzbget/       # fetch script for nzbgetcom binaries (not vendored)
├─ deploy/                   # Dockerfiles, compose, installers
├─ tools/                    # upstream-pull.ps1, fetch-jellyswarrm-media.ps1, build scripts
└─ docs/                     # ARCHITECTURE.md (this document), PATCHES.md
```

Upstream tracking: `git subtree add --prefix ... --squash` per repo, `tools/upstream-pull.ps1`
to `git subtree pull` all six. Patches land directly in the subtree directories; keep them
config-driven where a code patch can be avoided, and list every one in `docs/PATCHES.md`.

**Mesh workspace.** `mesh/crates/*` and `mesh/jellyswarrm` are deliberately two separate Cargo
workspaces, not one. Jellyswarrm's three crates use workspace-inheritance (`field.workspace =
true`) for `version`/`authors`/`repository` and for a ~40-entry `[workspace.dependencies]` table
(axum, sqlx, tokio, reqwest, etc., all pinned in its own `Cargo.toml`). Re-rooting them under
`mesh/Cargo.toml` as a single unified workspace was tried during M0 and fails twice over: first on
the missing `version`/`authors`/`repository` inheritance (fixable by adding those fields), then on
every one of its ~40 dependency-inheritance references (`workspace.dependencies` undefined at the
new root) — fixing *that* would mean copying Jellyswarrm's entire dependency table into our own
workspace manifest, permanently re-coupling the new `stingstream*` crates' dependency versions to
whatever Jellyswarrm pins, and guaranteeing a conflict the first time either side needs a different
version of something the other already pins. Each workspace builds independently
(`cargo build --manifest-path mesh/Cargo.toml` / `cargo build --manifest-path
mesh/jellyswarrm/Cargo.toml`, or `cd` into either and `cargo build`); CI runs both.

---

## Milestones

Each package: **model → deliverables → acceptance**. Packages inside a milestone can run in
parallel where noted.

### M0 — Repo, vendoring, builds green (Sonnet 5)

- Monorepo skeleton above; subtrees for the six upstreams; `tools/upstream-pull.ps1`;
  `tools/fetch-jellyswarrm-media.ps1`; root `.lfsconfig` and `.gitmodules` guards.
- Unmodified builds: `dotnet build` (jellyfin, radarr, sonarr v5, infinidysk), `cargo build`
  (mesh incl. jellyswarrm with `JELLYSWARRM_SKIP_UI=1`), `npx expo export --platform web`
  (expected to fail — record why, feeds M2 spike), Streamyfin `:tv` Android build if an SDK exists.
- GitHub Actions matrix for the three toolchains. LICENSE/NOTICE per component. `docs/ARCHITECTURE.md`
  and `docs/PATCHES.md`.
- Toolchains authorized for local install: .NET SDK 8 and 10 via winget, yarn via corepack.

**Accept:** clean clone → documented commands build every component on Windows and Linux CI.

**M0 status (2026-09-04): complete.** All six subtrees landed (streamyfin, jellyfin, radarr,
sonarr — re-vendored from `v5-develop`, see `docs/PATCHES.md` — infinidysk, jellyswarrm — landed
with its dev-fixture media as LFS pointers). Toolchains installed: .NET SDK `8.0.424` and
`10.0.400` via winget (alongside the pre-existing `9.0.310`, `2.1.100`, `1.0.4`); `yarn 1.22.22`
via `corepack enable` (with `--install-directory` pointed at the user-writable npm prefix, since
the default install directory under `Program Files\nodejs` needs admin rights this session
didn't have); a modern `curl` (`cURL.cURL` 8.21.0) via winget, ahead of Git for Windows' bundled
7.49.1 on `PATH`, to fix InfiniDysk's native-library fetch (see "Facts" above). Build results:
**all four .NET components succeed** (Jellyfin, Radarr, Sonarr v5, InfiniDysk — 0 errors each); the
two new `stingstream*`-crate and Jellyswarrm Cargo workspaces both **succeed** (and Jellyswarrm's
own test suite passes, 235 tests, 2 correctly-ignored integration tests); `yarn install` for
apps/stingstream **succeeds** cleanly with no extra flags; the Expo web export fails exactly as
expected, with the precise missing-dependency error captured for the M2 spike. Full
command-by-command results are in the M0 build report delivered alongside this milestone.

### M1 — One-node "one app" server (Opus 5)

- `mesh/crates/stingstream`: supervisor (spawn/monitor/restart, unified structured logs, single
  `STINGSTREAM_DATA`), gateway on 8790 routing `/` (placeholder page for now), `/jellyfin/*` →
  local Jellyfin, `/stingstream/api/*` → StingStream.Core.
- `server/jellyfin/src/StingStream.Core`: registered in Jellyfin startup; OpenAPI at
  `/stingstream/api/v1/openapi.json`; Omniarr sync service; MonoTorrent engine + qBittorrent API
  subset; NZBGet lifecycle + auto-registration; arr webhook receiver → targeted Jellyfin refresh;
  BLAKE3 hashing on import (background, throttled); inventory record builder (metadata blob and
  media summary per local item) ready for M3 to publish.
- Radarr/Sonarr: config.xml pre-seeding, localhost binding, API keys from supervisor. Zero code
  patches unless unavoidable — document any in `docs/PATCHES.md`.
- First-run wiring: root folders `Movies/` and `TV/`, both download engines registered in both
  arrs, Jellyfin libraries created, webhooks installed.

**Accept:** fresh machine → one command → add a movie via `/stingstream/api/v1` → grabbed from a
Torznab stub (CI: a MonoTorrent tracker seeding a generated test file) → downloaded by the embedded
engine → imported → appears in Jellyfin → **streams from Jellyfin's own API** at
`/jellyfin/Videos/{id}/stream`. Same for a series via Sonarr v5. Restart: everything comes back on
its own.

#### Where M1 deviated from the plan

Three things came out differently from the milestone as written. All three are deliberate and all
three still stand.

1. **Acceptance is the API equivalent, not stock jellyfin-web.** The plan said "plays in stock
   jellyfin-web at `/jellyfin`". That is not what a node runs: Jellyfin is started with
   `--nowebclient` because StingStream serves its own UI from the gateway (M2), and `jellyfin-web`
   is a separate repository that is not vendored here at all. The criterion is therefore the
   API-level equivalent — the item exists and its bytes come back over HTTP — which is what
   `tools/e2e-m1.ps1` asserts. Playing in a browser arrived with the M2 UI.
2. **The torrent engine's DHT is off by default**, with a settings toggle
   (`downloadClients.torrentDhtEnabled`, plus `torrentLocalPeerDiscovery` and
   `torrentListenPort`). Joining the public BitTorrent DHT announces the node to strangers, which
   is not something a media server should do the first time it starts because someone installed
   it. Private trackers forbid it outright. Local peer discovery stays on, because it is
   LAN-scoped.
3. **Windows children get no graceful stop until M8.** Killing the supervisor on Windows orphans
   its children: there is no portable equivalent of SIGTERM for another process, and the console
   control events that come closest cannot be sent to a process in a different console group.
   Ctrl+C on an attached supervisor stops everything cleanly, and so does SIGTERM on Unix; a hard
   kill leaves Jellyfin, the arrs and NZBGet running, and the next start finds their ports taken.
   Both acceptance harnesses therefore clean up by data directory rather than by name. Proper job
   objects are M8's packaging work.

#### What M1 settled

**Ports and routing.** The gateway is the node's only exposed listener, `0.0.0.0:8790` by default.
Children bind `127.0.0.1` on supervisor-assigned ports: `[ports]` in `config.toml` holds
*preferences* (8096 / 7878 / 8989 / 6789, matching upstream defaults), a taken port falls back to an
ephemeral one, and `0` always means "pick one". The real values land in `runtime.json`.

Jellyfin runs with `BaseUrl=/jellyfin`, and ASP.NET maps its entire pipeline underneath that — so
`StingStream.Core`'s routes really live at `/jellyfin/stingstream/...`, and the gateway rewrites
`/stingstream/...` onto them. Gateway routes, in match order:

| Path | Goes to |
|---|---|
| `/healthz` | the gateway: JSON child states, 200 when healthy and 503 when not |
| `/stingstream/mesh/*` | the mesh's loopback API, minus the `/stingstream` half — **from 127.0.0.1 only** (M3b) |
| `/stingstream/*` | Jellyfin, rewritten to `/jellyfin/stingstream/*` |
| `/stream/*` | the mesh: ranged reads of a peer's file, proxied byte for byte (M3b) |
| `/jellyfin/*` | Jellyfin, including the `/jellyfin/socket` WebSocket |
| `/sidedoor/v1/hello` | the gateway itself: which node, was this connection TLS, what address does the caller look like from here. CORS-open on purpose, and deliberately not `/healthz` — the racing probes are cross-origin, and `/healthz` carries child ports and the data directory (M3d) |
| `/radarr/*`, `/sonarr/*`, `/nzbget/*` | those children — **`--dev` only** |
| everything else | the web bundle, with SPA fallback; the placeholder page when there is no bundle (M3b) |

**The gateway sniffs the first byte of each connection** (`0x16` is a TLS ClientHello) rather than
running two listeners. Loopback plain HTTP keeps working exactly as before; an off-machine plain
request is answered with a `308` to `https` once a certificate exists; TLS responses carry HSTS. A
node with no certificate behaves as it always did (M3d).

`/stingstream/mesh/*` is restricted to loopback on purpose. The mesh API is unauthenticated because
it binds `127.0.0.1` and anything that can reach it is already on the machine — but the gateway
binds `0.0.0.0` so phones and TVs can reach the node, and proxying an API that creates groups and
mints invite codes onto that address would hand the group to anyone on the same Wi-Fi. The app uses
`/stingstream/api/v1/mesh/*` instead: the same operations behind Jellyfin's own authentication.

**Data directory.** One tree per node under `$STINGSTREAM_DATA` (`%LOCALAPPDATA%\StingStream` on
Windows, `~/.local/share/stingstream` elsewhere): `config.toml` (written once with defaults, never
rewritten), `runtime.json` (rewritten every start), `core.db`, `logs/*.jsonl` (one per child plus
the supervisor, JSON lines), `jellyfin/{config,data,cache,log}/`, `radarr/`, `sonarr/`, `nzbget/`,
`downloads/{torrents,usenet}/`, `media/{Movies,TV}/`, and `federated/{movies,tv}/` — the two
Shared libraries M3b materializes into. M3 adds `node.key` (the iroh identity), `mesh.toml`,
`mesh.db` and `tls/` — the node's own certificate, its key, and its ACME account (M3d) — alongside
them. See `docs/RUNNING.md`.

**`runtime.json` is the contract** between the Rust supervisor, `StingStream.Core` inside Jellyfin,
and the acceptance harness: assigned ports, generated arr API keys, NZBGet and qBittorrent-shim
credentials, the Jellyfin bootstrap administrator, resolved paths, and a `first_run` flag Core
clears once wiring succeeds. Generated secrets are carried forward across restarts, so a restart
never invalidates configuration already pushed into a child. Owner-only where the OS supports it.

**StingStream API** at `/stingstream/api/v1`, authenticated with Jellyfin's own tokens and
policies, self-described at `/stingstream/api/v1/openapi.json`:

| Endpoint | Purpose |
|---|---|
| `GET /status`, `GET /status/arrs` | node, engine, hashing, children, sync results, recent arr events |
| `POST /setup/run` | re-run first-run wiring (idempotent) |
| `GET/PUT /settings` | the Omniarr shared settings document |
| `GET/POST /settings/indexers`, `DELETE /settings/indexers/{id}` | indexer CRUD |
| `POST /sync`, `GET /sync` | push into both arrs; last result per app |
| `GET/POST /movies`, `GET/POST /series`, `GET /queue` | add and watch titles, routed to the right arr |
| `GET /inventory`, `GET /inventory/{itemKey}`, `POST /inventory/rebuild` | the records M3 will publish |
| `POST /webhooks/arr` | the arrs' event receiver (anonymous, loopback callers only) |
| `/stingstream/qbt/api/v2/*` | the qBittorrent-compatible subset the arrs use |

M4 added, all behind the same authentication:

| Endpoint | Purpose |
|---|---|
| `GET/PUT /users/{userId}/playback-policy` | Speed first or Quality first, per user |
| `GET /items/{id}/sources` | every holder, scored, with the reasons — the "Play from…" menu |
| `GET /items/{id}/availability` | whether anything needs downloading, plus the stored add decision |
| `POST/GET/DELETE /items/{id}/pin` | keep a copy here; progress; cancel |
| `POST /library/add` | add a title, checking the group first |
| `GET /library/state` | every recorded add decision |
| `GET /mesh/peers/{node}/stats?group=` | one peer's measured link, as the scorer sees it |

`{id}` on the `items` routes is a Jellyfin item id **or** a StingStream item key. Both are things a
caller legitimately has: the app has a Jellyfin id for anything on a library screen, and an item key
for anything it read out of the group index or got back from `POST /library/add` — which by
construction has no local item, because the point of that answer was that nothing was downloaded.

**Storage.** `core.db` is plain SQLite through `Microsoft.Data.Sqlite`, not EF Core. StingStream's
data is a handful of small tables; adding entities to Jellyfin's `DbContext` would hand its
migrations ownership of them, and a second EF model would have to be kept in step with whatever EF
version Jellyfin pins.

**Item key grammar** (the content identity M3's group index is keyed on):
`movie:tmdb:603`, `movie:imdb:tt0133093`, `episode:tvdb:73739:s01e01`. Providers are tried in a
fixed order so two nodes with different metadata coverage still agree.

**Deviations worth knowing.**

- **DHT is off by default** in the torrent engine, and the qBittorrent shim reports that honestly.
  A headless media server should not quietly join a global peer-to-peer network without being
  asked, and every release an indexer hands the arrs carries its own trackers. The cost is that a
  *trackerless* magnet is refused up front rather than stalling — which is the better failure.
  `[downloadClients].torrentDhtEnabled` turns it on.
- **Windows has no graceful child stop.** Ctrl+C sends `SIGTERM` and waits on Unix; on Windows the
  children are terminated, because `GenerateConsoleCtrlEvent` needs a shared console group and
  attaching to a child's console would signal the supervisor too. A hard kill of the *supervisor*
  on Windows also orphans the children. Revisit in M8 with a Job Object.
- **`IsStartupWizardCompleted` must not be pre-seeded** into Jellyfin's `system.xml`; see
  `docs/PATCHES.md` for why it crash-loops a fresh node.

**M1 status (2026-09-05): complete, acceptance passing on Windows and in CI.**
`tools/e2e-m1.ps1` runs the whole path end to end on a throwaway data directory and passes all 21
steps -- 109 seconds on the build machine, 8 minutes on the Linux runner including the four builds
(CI run 33955784834, every job green): node up and every child healthy in 15 s; first-run wiring; the Jellyfin WebSocket proxied
through the gateway (101 plus a real frame); the indexer added and synced into both apps; the movie
(TMDB 10378) grabbed, downloaded over the qBittorrent-compatible API, imported and streamed back as
2,197,380 bytes; the episode (TVDB 71471 S01E01) the same at 6,040,395 bytes; inventory records
built for both (`movie:tmdb:10378`, `episode:tvdb:71471:s01e01`); and after a hard kill and restart
every child healthy again, both items still present and both torrents restored from `core.db`. All
four download-client tests — the qBittorrent shim and NZBGet, in Radarr and Sonarr — pass from the
apps' own Test button.

Six things the acceptance runs taught the implementation, each worth knowing before touching this
code:

- **The Omniarr sync has to run on every start, not just the first.** Ports are assigned at
  start-up and can move, and the arrs *store* their download client's host and port; a node that
  wired itself only once came back from a restart with both apps talking to dead ports, logging
  nothing but "Unable to retrieve queue and history items" while completed downloads silently never
  imported.
- **A targeted refresh has to resolve downwards, not just walk up.** Nothing on the path of a
  brand-new title is a known item — not even the library's own media directory, whose
  `CollectionFolder` has a different `Path` and a no-op `ValidateChildrenInternal`. See
  `docs/PATCHES.md`.
- **The arrs' sample check is a table keyed on the title's runtime**, not a flat threshold: 90 s
  for a 10-minute title, 300 s for a 30-minute one. A file below it downloads perfectly and then
  sits in the queue forever as `importPending / Sample`.
- **Wiring has to wait for this server's own listener.** Hosted services start before Kestrel
  accepts connections, and the first thing first-run wiring does is register a download client
  pointing at the qBittorrent shim *in this process*. A fixed delay was long enough on the build
  machine and not on a CI runner. Provider resources are also created with `forceSave`, so the
  configuration lands whether or not the target answers at that instant.
- **The arrs' console assembly is named differently per platform.** `src/NzbDrone.Console`
  produces `Radarr.Console` on Windows, because the name `Radarr` belongs to the tray application,
  and plain `Radarr` on Linux where there is no tray application. The supervisor tries both, and
  searches the output tree if neither is where it expected.
- **The gateway needs a dedicated connection for protocol upgrades.** `hyper_util`'s pooled client
  never calls `Connection::with_upgrades()`, so `hyper::upgrade::on` on one of its responses never
  resolves and a WebSocket handshake dies at the transport with nothing in any log.

### M2 — Unified UI v1 on one node (Sonnet 5; web-target spike by Opus 5 first)

- **Spike (Opus, gate):** add a web target to the Streamyfin fork — `react-dom`,
  `react-native-web`, Expo web platform config — with a player abstraction (MPV native untouched,
  `<video>` + hls.js on web), native-only modules shimmed, and the existing `:tv` variant still
  building. Time-box it. If web fails, the fallback that still honours "one UI" is a web-first
  React app wrapped in Capacitor with a native player plugin and a TV shell — decision recorded in
  this document before screens start.
- `packages/api-client` generated from the StingStream OpenAPI.
- Screens: Manage, Downloads, Server settings, Admin essentials, Node status (Group/Requests wait
  for M3/M6). Reuse Streamyfin's existing Jellyfin screens as-is. TV variant: browse/play only,
  D-pad focus verified on an Android TV emulator.
- Gateway serves the web bundle at `/`; Jellyfin started with `--nowebclient`.

**Accept:** every M1 action doable from the StingStream UI in a browser and in dev builds on an
Android device, without ever opening a Jellyfin, Radarr, Sonarr or NZBGet page. Browse and play
works on an Android TV emulator with a remote.

### M3 — Mesh v1: groups, coordinator, federated library, side door (Opus 5)

Run as three packages: **M3a** the mesh and the coordinator, **M3b** the federated library, the
mesh embedded in the node and the two-node acceptance, **M3c** the app's embedded mesh and the
Group screen.

- `stingstream-mesh`: persisted node key; iroh endpoint with per-group relay; HTTP/1.1-over-QUIC
  server exposing the local gateway to authenticated peers (ALPN `stingstream/http/1`); peer
  client keyed by node ID; `iroh-gossip` topic per group carrying signed inventory snapshots and
  deltas plus heartbeats; SQLite `group_index`; `/stream/<group>/<item_key>/<node>` endpoint that
  proxies HTTP range requests to the named source node over iroh (single fixed source in M3;
  scoring and failover come in M4).
- Group lifecycle: create (ID, secret, optional coordinator URL), invite code, join via an online
  member or the coordinator's rendezvous, leave, membership gossip, connection auth (group-secret
  proof + node signature).
- **Zero-server default:** a group created with no coordinator works on iroh's public relays, n0
  DNS discovery and mainline-DHT discovery, with the inviter's address carried in the invite so a
  join needs no lookup. Dan's Railway coordinator is appended to every relay map as the
  lowest-priority fallback.
- **Federated library v1 in `StingStream.Core`:** inventory publisher; Shared Movies / Shared TV
  libraries with NFO-only metadata; materialization of `.strm` + `.nfo` + images for titles not
  held locally, one version per holding node; MediaStream enrichment after refresh; offline-peer
  unavailable tagging with grace-period removal; PlaybackInfo hook returning `stingstream.local`
  MediaSources (unscored order in M3). Verify episode multi-version support on the vendored
  Jellyfin; record the result and fallback in this document. **Done — it works; see "What M3b
  settled".**
- App: embedded iroh endpoint (Kotlin bindings; no Swift/iOS work) with the `stingstream.local` URL
  rewrite so MPV streams from the app's own mesh; Group screen (create/join/invite/members) with a
  **coordinator picker** — "Default" (public infrastructure plus Dan's fallback) or "My own server"
  taking a hostname, validated live against `/healthz`, stored on the group and carried in invite
  codes so every member follows it. A "Host your own" link opens the guide.
- `stingstream-relay` **coordinator**: one binary, Lite and Full feature flags, Docker image
  published to GHCR by CI, Dan's Lite instance deployed to Railway, a Railway template so anyone
  can deploy their own in one click, and the `storage-node` compose profile plus the VPS hosting
  guide for Full mode.
- **HTTPS side door, coordinator half:** per-node hostnames via the IP-reflecting zone (Full) or
  provider-API records (Lite, Cloudflare behind a provider trait); signed-request TXT endpoint for
  ACME DNS-01; SNI router on 443 fronting iroh-relay with per-node TCP passthrough over iroh,
  restricted to registered nodes; reachability probe writing `direct_https` into discovery records;
  the coordinator's own Let's Encrypt certificate. Both modes pass the same side-door tests.
- **HTTPS side door, node half:** ACME client (`instant-acme`) with the key generated and kept on
  the node; rustls on the gateway (8790, optional 443); `portmapper` TCP mapping for the gateway
  with the result and manual-rule fallback surfaced on Node status; side-door candidate hostnames
  published in the discovery record. Web bundle: connection racing across LAN, public and relay
  hostnames with the winner remembered per network.
- Install Docker Desktop and a JDK 17 + Android SDK on the build machine (not yet installed as of
  M0) as this milestone needs them.

**Accept:** two nodes behind different NATs (Dan's LAN + a second network, with Docker-simulated
NAT in CI) join a group by invite **with no coordinator configured** and stream each other's files
using only public infrastructure. Then the same with Dan's Railway coordinator selected. A user on
node A opens A's own Jellyfin through the app and sees B's titles in Shared Movies and Shared TV
with correct posters, overviews and resolution badges, and plays B's file direct while A's mesh
traffic counters show the bytes did not pass through A. Stop the coordinator after connection →
playback continues on the direct path. Block UDP hole-punching → playback still works via relay.
Block *all* UDP on a node → mesh traffic still flows through a relay on TCP 443. Take B offline →
its titles grey out on A within a minute and return when B does. Side door via the Railway
coordinator: from a phone on cellular, a browser opens `https://pub.<nodeid>.direct.<host>:8790`
with a valid padlock and no warning; firewall inbound on that node so it looks like CGNAT → the
client races to the `relay.` hostname and still gets a padlock, and the node's `direct_https` flips
to `blocked` within a minute.


#### What M3b settled

**The mesh runs inside the node's process.** `stingstream` links `stingstream-mesh` and calls
`MeshNode::spawn` in its own process rather than spawning the binary as a child. One fewer process
to find, supervise, restart and kill; the mesh's `tracing` output joins the supervisor's structured
log instead of being scraped off a pipe; and shutdown is an `await` rather than a signal Windows
cannot deliver to another process. It still binds its documented loopback API port, because
`StingStream.Core` and the app both talk to it over HTTP, so the gateway keeps proxying
`/stingstream/mesh/*` and `/stream/*` over loopback — one code path whether the mesh is embedded or
supervised, and the extra hop is a copy through the kernel's loopback next to a QUIC transfer.
`[mesh] embedded = false` restores the child, which is how you attach a debugger to just the mesh.

**The federated library, end to end.** `StingStream.Core/Federated/` compares the group index
against what has been materialized, writes or removes pointer files, refreshes only the folders
that changed, and stamps what the index already said onto the resulting items:

* `Shared Movies` and `Shared TV` are created with an empty `TypeOptions` entry per item type —
  which is what actually disables the internet fetchers, because those lists are *allow*-lists and
  only apply to a type that has an entry at all — `LocalMetadataReaderOrder = ["Nfo"]`, and
  `MetadataSavers = []`. That last one is not cosmetic: Jellyfin runs its metadata savers on every
  item update, and a saver would rewrite the `.nfo` the materializer had just written.
* Layout is `Title (Year)/Title (Year) - <node> <quality>.strm` for films and
  `Series/Season 01/Series - S01E01 - <node> <quality>.strm` for episodes, with a `.nfo` beside each
  (plus `movie.nfo` and `tvshow.nfo`, which are the names Jellyfin's NFO providers look for first),
  folder-level `poster.jpg`/`fanart.jpg` for films and series, and `<episode>-thumb.jpg` for
  episodes — because episodes are served by a *different* local image provider that recognises
  exactly two names and no backdrop at all.
* Artwork comes from the holder over the mesh (`/peer/v1/image/{item_key}/{kind}`), so no node in a
  group asks a metadata provider anything.
* MediaStreams, runtime, container, size and dimensions are written straight into Jellyfin's own
  tables from the index record, so the resolution and codec badges are right the moment the item
  appears and nothing is ever probed.

**It polls the index rather than subscribing to it, and that was a choice.** The milestone allowed
either, and offered to add an SSE or long-poll endpoint to the mesh if one were needed. One is not:
a pass is a `GET` against a local SQLite database over loopback followed by a set comparison, it is
idempotent, and it is cheap enough at fifteen seconds that a peer's new import appears about as
fast as a local one. A change feed would add a second failure mode — a subscription that silently
stops delivering — to a system that currently cannot get stuck, because the next pass re-reads
everything from scratch. `POST /stingstream/api/v1/mesh/federated/refresh` forces a pass for a
harness or an impatient administrator.

**Peer titles are untrusted input, and they become folder names.** `Federated/SafePath.cs` rebuilds
each component from an allow-list of characters rather than stripping dangerous ones out, refuses
components that are only dots, prefixes reserved Windows device names, trims the trailing dots and
spaces Windows silently drops, caps each component at 96 characters (a *path* limit, not a
filesystem one — the deepest federated path is root + library + series + season + filename), and
falls back to a token derived from the item key when nothing survives. The assembled path is then
checked to be inside the federated root, with both paths fully resolved, before a byte is written.
Two different titles that sanitise to the same folder name get a stable disambiguator from their
item keys rather than being merged into one item.

**PlaybackInfo needed less interception than expected, and one patch.** Jellyfin already turns a
`.strm` into a `MediaSourceInfo` with `Path` = the URL inside the file, `Protocol = Http`,
`IsRemote = true` and a `Name` derived from the filename — which, given the naming above, *is* the
node-and-quality label. So the hook the plan asked for is mostly already there;
`SupportsDirectPlay` is then decided by Jellyfin's `StreamBuilder` from the streams the materializer
stamped, which is the right answer rather than an asserted one. What did need changing is one
condition in `MediaSourceManager.GetPlaybackMediaSources`, which force-probed *every* `.strm` on
*every* PlaybackInfo call — pulling a peer's film across the mesh through ffmpeg on every play to
rediscover what the holder had already published. See `docs/PATCHES.md`.

**Non-mesh clients work through a message handler, not DNS.** `stingstream.local` resolves nowhere
on purpose: the native app rewrites it to its own embedded mesh. For a browser or a stock client,
Jellyfin fetches the URL itself with an ordinary `HttpClient`
(`FileStreamResponseHelpers.GetStaticRemoteStreamResult`, which forwards `Range` and passes back
`206`/`Content-Range`/`Accept-Ranges` — exactly what a seeking player needs), and
`StingStreamLocalHandler` rewrites that one hostname to this node's own gateway on the way out. A
`DelegatingHandler` rather than a DNS-level `ConnectCallback`, because the URL is `https` and the
gateway speaks plain HTTP on loopback; rewriting the whole URI changes the scheme too. **ffmpeg does
its own DNS and never sees the handler**, so a *transcode* of a federated source does not work yet —
direct play does, and the transcode fallback is M4's.

**Episode multi-version support: yes, on this vendored Jellyfin.** The plan flagged this as the one
thing M3 had to *verify* rather than assume, with "one best version per episode" as the fallback.
`tools/e2e-m3.ps1` answers it directly rather than by inference: it writes two `.strm` files for one
episode into a single `Season 01` folder, differing only in the node-and-quality label, each with
its own `.nfo`, refreshes, and asks Jellyfin what it made of them. **Two versions became one Episode
item with two MediaSources**, with a control pair of movie versions behaving the same way, so the
answer is about episodes specifically and not about grouping in general.

The mechanism is `Emby.Naming/Video/VideoListResolver.cs`, which dispatches on collection type:
`GetVideosGroupedByVersion` for films (every filename must start with the folder name, and all files
must agree on the year) and `GetEpisodesGroupedByVersion` for TV, which keys on the parsed `SxxEyy`
and ignores the folder name entirely. `MovieResolver` is what passes `supportMultiEditions: true`
for a `tvshows` library, and it acts as the `IMultiItemResolver` for the season folder;
`EpisodeResolver` does no grouping of its own. That is a newer arrangement than the one the plan was
written against, which is exactly why it was worth checking rather than assuming either way.

**The fallback is therefore not needed**, and M4 can materialise one `.strm` per holding node and
quality for episodes as well as films. The verification step stays in the harness: it is cheap, and
it is the thing that will notice if an upstream pull takes the behaviour away again.

**What the acceptance run actually proved.** `tools/e2e-m3.ps1`, on Dan's machine, two complete
nodes with their own Jellyfin, Radarr, Sonarr, NZBGet and iroh identity:

| Step | Result |
|---|---|
| B grabs and imports a movie and an episode through the M1 pipeline | pass |
| A creates a group with **no coordinator**; B joins with A's invite | pass, `via: inviter` |
| B's inventory reaches A's group index, with no `local_path` anywhere in it | pass |
| A materializes Shared Movies and Shared TV | pass |
| The federated movie has a poster, an overview and a `1920x1080 h264` badge | pass |
| PlaybackInfo returns a `stingstream.local` source, `Protocol=Http`, `SupportsDirectPlay=true` | pass |
| `GET /jellyfin/Videos/{id}/stream` on A returns B's file **byte for byte** | pass |
| `GET /stream/{group}/{key}/{node}` with a `Range` returns `206` and the right bytes | pass |
| Episode multi-version support on this Jellyfin | **supported** |
| B stops; A tags its versions `stingstream:unavailable` within a minute, keeping the items | pass |
| B returns; the tag clears | pass |
| A group with Dan's Railway coordinator; the invite carries it to B | pass |
| A rendezvous join with the inviter offline | pass, `via: rendezvous` |

Twenty steps, 808 s end to end on a warm machine, everything above the coordinator rows on loopback
with nothing hosted by anyone.

Two things the run also settled about *timing*, both worth knowing before reading a slow run as a
fault. Gossip converges in about a second — both nodes log the snapshot arriving — but the *first*
materialization pass is slow, because a Jellyfin that has just had two libraries created and is
scanning them can take tens of seconds to answer an API call. Every pass after it is instant. And
two nodes on one machine reach each other over a `direct`/`mixed` iroh path with an RTT in the low
tens of milliseconds; the NAT scenario in `mesh/tests/nat/run.sh` is what exercises the relayed
case.

**The gateway restricts `/stingstream/mesh/*` to loopback.** The mesh API is unauthenticated because
it binds `127.0.0.1`; the gateway binds `0.0.0.0`. Proxying an API that creates groups and mints
invite codes onto a LAN address would have handed the group to anyone on the same Wi-Fi. The app
uses `/stingstream/api/v1/mesh/*` instead — the same operations behind Jellyfin's own auth.

**Three bugs the two-node run found that no unit test would have.**

1. `IPathRefresher` refreshed a folder that was already a known item without validating its
   children, and `RefreshMetadata` on a `Folder` does not descend. So a season folder that already
   existed got re-read and the new episode inside it was never noticed — a Series and a Season with
   nothing in them. The arr-import path never hit it because that path names a *file*.
2. `FederatedStore.Parse` passed `DateTimeStyles.RoundtripKind | AdjustToUniversal`, which .NET
   rejects outright. The only code path that reaches it is the *first* pass after a peer goes
   offline, so the whole pass threw and the symptom was "the unavailable tag never appears" — three
   layers away from a date-parsing bug.
3. The materialization pass could run twice concurrently — once from the timer, once from
   `POST /mesh/federated/refresh` — with one deleting what the other had just written. Now
   serialized on a semaphore.

**And one found by reading it back afterwards, which matters more than any of them.** The mesh
client returned an *empty* index when the mesh was merely unreachable, and the materializer reads an
empty index as "the group holds nothing" and deletes every pointer. One restart of the mesh process
would have taken a node's whole Shared library with it. `GroupsAsync`, `IndexAsync` and `PeersAsync`
are now nullable — null means "could not ask", and a pass that cannot read the mesh does nothing at
all rather than something confident and wrong.

**Still outstanding from M3.** The HTTPS side door's *node* half (ACME, rustls on the gateway,
`portmapper`, publishing the candidate hostnames) has not shipped, and is the largest single piece
of M3 left. Multi-version materialization with more than one holder, and the scoring that picks
between them, are M4 as planned.

### M4 — Source selection, shared downloads, failover (Opus 5)

- Multi-version materialization: one `.strm` per holding node and quality inside the same title
  folder so Jellyfin exposes alternate versions; episode handling per the M3 verification.
- Source-selection engine in `StingStream.Core`'s PlaybackInfo hook: candidate scoring from
  iroh path info, rolling throughput, quality fit and advertised load; Speed-first / Quality-first
  setting; per-play override list; advertised capacity limits respected.
- Mesh `/stream` endpoint: same-hash failover by byte offset across holders; app restarts by
  timestamp on the next MediaSource when files differ. Transcode fallback: home-node transcode of
  the remote source, with a measured-bandwidth trigger.
- Dedupe in the add/request flow; "available via group" state in the UI; pin/mirror fetch over
  iroh into a local root folder → import → pointer entry removed.
- Concurrency: N viewers on M sources at once.

**Accept:** same movie on B (1080p) and C (4K). Viewer on A with Speed-first on a throttled link
gets B; Quality-first gets C, or A's transcode of C when the link is too slow. Kill B mid-play →
resumes from C within about 5 seconds. Adding a movie already on B from A triggers no download.
Pinning it on A copies it, removes A's pointer entry, and the index shows two sources. Three
viewers streaming three different files from B simultaneously all play.

**M4 status (2026-09-05): complete, acceptance passing on Windows.** `tools/e2e-m4.ps1`, three
complete nodes on one machine, 239 seconds:

| Step | | |
|---|---|---|
| Two encodes of one film, plus two more films, at real constant bitrates | pass | 6.2 s |
| B (fast holder) starts with three films, Big Buck Bunny at 1080p | pass | 22.4 s |
| C starts throttled to 1 MB/s and one stream slot, with the 4K and a byte-identical copy of B's Sita | pass | 21.5 s |
| B and C inventory what they hold | pass | 10.7 s |
| A starts empty; group with no coordinator; both join | pass | 17.8 s |
| Both holders' inventories reach A's index, with one hash shared and two distinct | pass | 5.3 s |
| A materializes **one folder with two `.strm` versions** — one item, two MediaSources | pass | 4.7 s |
| A measures both links: **B 34 Mbit/s, C 9 Mbit/s** | pass | 5.3 s |
| **Speed first picks B (87.9 v 70.2); Quality first picks C (90.0 v 68.6)** — `/items/{id}/sources` and PlaybackInfo agreeing | pass | 0.5 s |
| **Quality first on a link that cannot carry it transcodes on A**: ffmpeg's `-i` is `http://127.0.0.1:8880/stream/…`, and a 26 MB HLS segment of C's 4K comes back | pass | 30.7 s |
| **C's one stream slot**: two concurrent readers, the second gets `503` and continues from B — 30.2 s and 7.6 s, both byte-exact | pass | 48.1 s |
| Three concurrent streams from B, all byte-exact | pass | 19.7 s |
| Adding a film the group holds starts no download; "available via group" is persisted | pass | 0.1 s |
| Pinning it copies it into A's own root folder, removes A's pointer, and takes the holders from one to two | pass | 8.2 s |
| **B killed mid-stream: continued from C after 3.4 s, byte-exact over 30 MB** | pass | 37.7 s |

Everything on loopback, with nothing hosted by anyone. The two throttles are the mesh's own
serving-side cap, not a simulation.

#### What M4 settled

**One hook was not enough, and neither hook alone would have done.** The obvious place to order
`MediaSources` is the PlaybackInfo controller — an MVC filter, no vendored patch at all. That place
is wrong on its own: Jellyfin resolves an item's media sources *twice*, once for the client in
`MediaInfoHelper` and again server-side with no client involved in `StreamingHelpers`, on every
stream and every transcode segment. Decorating only the API response would hand the client one
answer and the transcoder another — which matters here more than anywhere, because the whole
transcode fix is that the URL ffmpeg gets must *differ* from the URL the client gets. So the primary
hook is `IMediaSourceDecorator` at the end of `GetPlaybackMediaSources`, the one funnel both paths
go through (`docs/PATCHES.md`).

The other place turned out to be necessary too, and only a live run could have shown it.
`MediaInfoController` calls `MediaInfoHelper.SortMediaSources` **after** the decorator has run, and
that sort begins by floating "the source belonging to the queried item" to the front. Upstream's
rule is right for what it was written for: a user opening one version of a film they hold two copies
of expects *that* version, because it carries their resume position. For a federated title every
version is a pointer at somebody else's disk, none of them is the one the user opened, and which is
the primary item is an accident of which `.strm` the resolver read first. Letting that accident
outrank a measured link hands a viewer on a slow connection exactly the holder they cannot reach —
which is what the harness caught, with the scorer's own log line one line above the failure saying
it had chosen the other one. So the order is applied twice: in the decorator, for everything the
server does, and again in a result filter for the response the client reads.

**The transcode fix needed no encoder patch, and that was a surprise.** M3b left it as "ffmpeg does
its own DNS and never sees `StingStreamLocalHandler`", with the expectation that M4 would patch
`EncodingHelper` or `MediaEncoder`. It did not have to: `MediaSourceInfo.EncoderPath` /
`EncoderProtocol` already exist for exactly this, and `AttachMediaSourceInfo` already prefers them.
Live TV has been using the mechanism all along.

**Bandwidth has to be real, or the test passes for the wrong reason.** The harness caps node C's
link with the mesh's own serving-side throttle rather than simulating a slow peer with a smaller
file, because file size is not the input the scorer weighs. The same principle bit once more, one
level down: the generated clips are encoded **constant-bitrate**, because a colour-bar test pattern
is a static image and x264 compresses twelve seconds of it to a couple of hundred kilobytes whatever
`-b:v` says. With the fictional bitrate that produced, every source "fit" every link and Speed-first
and Quality-first returned the same answer — a green run that proved nothing. `-minrate` with
`nal-hrd=cbr` makes a 4K source really need 20 Mbit/s.

**Three films were enough to take a node off the air.** The most valuable thing the harness found,
and it had nothing to do with source selection. `iroh-gossip`'s default `max_message_size` is 4096
bytes; an inventory snapshot of three ordinary records exceeds it; and the refusal lands on the
*send* side of connections that are already established. So the publishing node stops being able to
broadcast anything at all — to anybody — while continuing to receive normally. From outside, a peer
simply goes quiet and every other member declares it offline a heartbeat later. Nothing in any log
said so, because the one line that would have was at `debug`.

The two-node M3 acceptance never came close: one or two small records stayed under 4 KB. It took a
third node, and a third film, to cross the line — and any real library would have crossed it on day
one. The fix raises the frame limit to 256 KiB (a constant, not a setting: every member of a group
must agree, or a mixed-version group reproduces exactly this silence) *and* chunks snapshots and
deltas, because no ceiling makes a ten-thousand-title library one message. `chunk == 0` replaces
what is known about the author and later chunks merge, so a lost chunk costs those records until the
next snapshot rather than corrupting the ones that arrived. The broadcast failure now logs at warn,
with the size.

**A measurement that only happens at end-of-body never happens.** The obvious way to record
throughput is to measure the transfer and write it down when the upstream body reports EOF. It
never fired. The response carries a `Content-Length`, so once hyper has written that many bytes it
considers the message complete and drops the body without polling it again — the generator is
dropped mid-`await` and the EOF arm is unreachable. Every completed range read looked, to the
scorer, like a link that had never been used, and every source scored identically. Recording on
`Drop` fixes it and is better besides: a player that abandons a seek after three seconds still
delivered three seconds of real bytes, and that is a sample worth having.

**A killed holder closes nothing.** Failing over on a body error is not enough: a process that is
killed does not close its QUIC connection, it just stops answering, and iroh will not call that a
failure until its own idle timeout tens of seconds later — long after a player has given up. Hence
`peer.stream_stall_secs`: a body that produces nothing for the timeout is treated as failed. That is
what makes the milestone's "about five seconds" a bound rather than a hope.

**Two implementations of one formula, deliberately.** `SourceScorer.cs` and `score.rs` carry the same
weights and the same test cases. The alternative is the mesh asking Core which source to use for
every range request, which puts a .NET process in the path of every seek and makes failover depend
on the component most likely to be busy. The cost is a real one and is paid on purpose; the thing
that keeps them honest is that both sets of tests assert the same cases in their own languages, and
`tools/e2e-m4.ps1` asserts that `/items/{id}/sources` and PlaybackInfo agree.

**Jellyfin's own version label truncates a node name at its last hyphen.** A pointer written as
`Big Buck Bunny (2008) - stingstream-c 2160p.strm` comes back from PlaybackInfo with the
`MediaSource.Name` `c 2160p`, not `stingstream-c 2160p`. Cosmetic, and only for clients that read
Jellyfin's own name — StingStream's own "Play from…" reads `nodeName` from
`GET /items/{id}/sources`, which is the whole name. Recorded because the first reaction to seeing
`c 2160p` in a log is to go looking for a bug in the materializer, and there isn't one.

**Label collisions are the silent multi-version failure.** Jellyfin groups same-folder files into
alternate versions *by name*. Two holders that both defaulted their node name to the machine's
hostname and both hold the same encode produce the same label, and the second `.strm` overwrites the
first — one source where there should have been two, looking from outside exactly like a peer that
never published. Labels are therefore decided across every holder of a title at once, and when two
collide, *both* get their short node id appended so the names do not shuffle when a third holder
appears.

### M5 — Android phone and TV release readiness, offline (Sonnet 5)

- Production Android and Android TV builds (local Gradle; EAS not available), branding,
  QuickConnect across the mesh (TV logs in by approving a code on a phone), mesh-aware source choice
  for offline downloads, background downloads, TV ten-foot polish (focus, remote shortcuts, resume).
  No iOS work.
- Chromecast over the HTTPS side door: the sender races LAN/public/relay hostnames of the *source*
  node and hands the receiver the winner. DNS-rebinding detection with the whitelist hint and
  plain-HTTP LAN fallback on the Node status screen. Any TV web view uses the trusted side-door URL.

**Accept:** signed phone APK and signed TV APK. Download an episode from a peer node, go to
airplane mode, play it. On the Android TV emulator: pair via QuickConnect, browse the merged
library, play a peer's file with the remote. Cast acceptance (home and cellular, no certificate
prompt) is written as a manual checklist for Dan since no Chromecast is available to agents.

### M6 — Requests (Sonnet 5)

- Requests service in `StingStream.Core` (requests, approvals, group policy auto-approve / by
  role), routing to a fulfilling node (home node, else volunteer by indexers + free space), in-app
  and Jellyfin notifications. App: adapt Streamyfin's Seerr screens to the StingStream requests API.

**Accept:** a non-admin on node A (no usenet) requests a series; node B fulfils it; it appears for
everyone; requester is notified.

**M6 status (2026-09-05): built.** `docs/REQUESTS.md` is the reference — states, policy, the claim
protocol, the endpoint table. The parts worth knowing from here:

- **Requests are answered against the group index first.** A title a member already holds comes back
  `available` having downloaded nothing, and the row's `note` says so. That is why Jellyseerr was
  dropped rather than kept: a Seerr instance sits in front of one Radarr and one Sonarr and cannot
  know what the *group* has, which in a library-pooling group is the interesting answer. The
  upstream screens and settings stay in the tree so an upstream pull still merges; nothing routes to
  them.
- **The claim decides who grabs it, with no coordinator.** The heartbeat gains
  `can_fulfil_movies` / `can_fulfil_tv` (an arr running, an enabled indexer for that kind, a root
  folder, and room), and the winner of a request is
  `min over live claims of (claimed_at_ms, node_id)` — a pure function every member computes for
  itself. `claimed_at` is frozen at the first claim and never moves, which is what makes a re-claim
  after a restart resume rather than hand the job away; `released` and `failed` drop out of the
  ordering, so a second volunteer inherits without being told. A node that is not the origin waits
  20 s before claiming, so the requester's own node wins when it can rather than winning a coin toss
  on node id.
- **`Option<bool>` on those two flags, deliberately.** Core's capacity push carries neither, and a
  plain `false` would erase the node's answer on every beat — the same trap the side door's own
  separate endpoint exists to avoid. They are published by M6's own loop through
  `PUT /mesh/v1/fulfilment`.
- **The activity log is Jellyfin's notification service now.** Its `INotificationManager` moved to
  plugins years ago, so a request notification is three things at once: a polled row in
  `notifications`, a `DisplayMessage` to live sessions, and an `IActivityManager` entry the dashboard
  renders. All three failures are swallowed; a notification that could not be delivered must not fail
  the state change it was reporting.
- **M6's five `core.db` tables are declared in `RequestStore`, not `CoreDatabase.ApplySchema`.** Same
  database, same `IF NOT EXISTS` statements; the reason is the shared checkout — `RequestStore.cs` is
  one package's alone and `CoreDatabase.cs` is edited by all of them at once.
- Acceptance: `tools/e2e-m6.ps1`, two nodes, node A with no arrs and no indexers at all so its
  inability to fulfil is configuration rather than a mock.

### M7 — Watch-together, subtitles, Live TV, storage-node polish (Opus 5 for SyncPlay; Sonnet 5 for the rest)

- Watch-together: within one home node, Jellyfin's native SyncPlay already covers federated items;
  verify and fix. Across nodes, a mesh **SyncPlay bridge** relays group state and play commands
  between the two nodes' Jellyfin SyncPlay sessions for the same item_key. Far smaller than
  proxying every WebSocket.
- Subtitles: Jellyfin OpenSubtitles plugin on by default; group-wide "wanted languages" job that
  fetches once and publishes via inventory so pointer entries get the sidecars too.
- Live TV/DVR: DVR recordings are ordinary files, so they flow through inventory and the federated
  library. Live channels stay per-node in v1; cross-node tuner sharing is best-effort later.
- Relay `storage-node` profile hardened and documented.

**Accept:** two members on the same node watch in sync natively; two members on different nodes
watch in sync through the bridge with under 1 s drift. New import gets subtitles in the group's
languages within a scan cycle. A DVR recording on B plays on A's TV.

### M8 — Packaging, updates, hardening (Sonnet 5, then `/security-review`)

- Installers: Windows (winget/MSIX), macOS pkg, Linux deb + AppImage, Docker. Self-contained .NET
  publish, Rust binary, NZBGet binary bundled. Update channel. Play Store listings for phone and TV.
- Security: member revocation and group key rotation, localhost binding audit for all children,
  dependency audit, pointer-file path sanitisation (titles from peers are untrusted input when they
  become folder names). Side door specifically: the TXT endpoint accepts only requests signed by
  the node that owns the name, the SNI router routes only registered nodes, probe requests are
  rate-limited, certificate keys on the node are file-permission restricted, and the gateway sends
  HSTS. Upstream pull cadence documented (monthly).
- Decide whether to drop the `mesh/jellyswarrm` subtree entirely (one authorized `git rm`) once
  nothing imports its `jellyfin-api` crate.

**Accept:** install on a clean Windows box and a clean Ubuntu box from the release page; both
join a group with one code; `/security-review` findings triaged.

### M8a — Packaging, installers and the release pipeline (Sonnet 5) — done; hardening half of M8 still to come

The half of M8 above that is packaging rather than security. See `deploy/node/LAYOUT.md`,
`docs/INSTALL.md` and `docs/RELEASING.md` for the full detail; this is the summary that belongs in
the wide view.

- **The install tree** (`deploy/node/LAYOUT.md`) is one shape shared by every delivery mechanism:
  `bin/{stingstream,mesh/stingstream-mesh,jellyfin,radarr,sonarr,nzbget,ffmpeg}/`, `web/`, `LICENSE`,
  `NOTICE.md`, `VERSION`. `tools/package-node.ps1`/`.sh` build it for one RID at a time,
  self-contained but deliberately **not trimmed** (`PublishTrimmed` is unsafe for ASP.NET Core plus
  Jellyfin's reflection-based plugin loader, and neither Radarr nor Sonarr's own build system uses
  it). Every launcher this milestone writes passes `--install-root` explicitly rather than relying
  on the binary's own argv[0]-relative fallback — see that document's own note on why the two
  disagree on purpose.
- **`deploy/node/Dockerfile`** builds the same tree inside a multi-stage, linux/amd64 +
  linux/arm64 image, published as `ghcr.io/danpatten/stingstream-node` by
  `.github/workflows/images.yml` on every push to `master` (mirroring `coordinator.yml`'s pattern
  for the coordinator image, but as its own workflow so the two do not queue behind each other).
  `deploy/coordinator/compose.yml`'s `storage-node` profile now points at it for real.
- **Joining a group from an environment variable** (`STINGSTREAM_JOIN_CODE`) is a small additive
  change in `mesh/crates/stingstream/src/main.rs`: once the embedded mesh is up, the supervisor
  calls `MeshNode::join` directly (no HTTP round-trip needed — it already holds the `Arc<MeshNode>`)
  if the variable is set. Idempotent, so it is safe to leave set across restarts. A second small
  addition, `--node-name`/`STINGSTREAM_MESH_NODE_NAME`, overrides `config.toml`'s `node_name` the
  same way `--port` already overrode the gateway port, for the same container-friendly reason.
- **Windows service mode** (`--service`, `mesh/crates/stingstream/src/service.rs`, the
  `windows-service` crate) registers the supervisor itself with the Service Control Manager rather
  than wrapping it in a generic service host (NSSM et al.) — see `docs/RELEASING.md` "The
  service-mode approach" for why that distinction matters for a clean stop. Linux and macOS get the
  same clean-stop property for free from systemd and launchd respectively, needing no equivalent
  in-process mode.
- **`--healthcheck`** is a synchronous, dependency-free GET of `/healthz` over loopack, added so
  `deploy/node/Dockerfile`'s `HEALTHCHECK` (and CI's own smoke tests) do not need curl or wget in
  the runtime image.
- **The update check** (`mesh/crates/stingstream/src/updatecheck.rs`) polls a published
  `version.json` daily and adds `latest_version` next to `/healthz`'s existing `version` field.
  Deliberately the smaller half of "show update available": comparing the two and surfacing
  anything in the UI is left as a TODO for whoever owns `StingStream.Core`'s status surface or the
  web app, so that decision (semver handling, dismissing a notification, per-channel opt-in) is not
  made twice.
- **What is verified where** (the honest version; `docs/RELEASING.md` has the full table): Windows
  build + package verified locally on Dan's machine, installer *compiled* but not silently
  installed anywhere automated; Linux `.deb` **actually installed and its systemd unit checked**
  against `/healthz` in CI, on a real (non-emulated) Ubuntu VM, for linux-x64 only — linux-arm64 is
  build-verified; the node Docker image is smoke-tested in CI for both architectures via QEMU;
  macOS artifacts are built and given a real (if partial) smoke test on genuine GitHub-hosted Mac
  hardware — the first place in this entire project anything has run on real Mac hardware — but
  full multi-child startup on macOS remains unverified anywhere, and nothing is code-signed or
  notarized on any platform (needs Dan: an Authenticode certificate, an Apple Developer Program
  membership).

---

## Verification (end-to-end, after M4)

1. Three nodes: Dan's Windows desktop, a Linux Docker host, a VPS running `stingstream-relay` with
   the `storage-node` profile. Create the group on the desktop, join the others by invite.
2. Two users, one per home node, log in from the web UI, an Android device, and a Google TV. Each
   sees only their own accounts on their own node, and the whole group's content.
3. Add a public-domain movie on node A; confirm it downloads once (embedded torrent engine) and
   appears in every other node's Shared Movies within a minute with poster and badges. Add the same
   title from node B; confirm no second download.
4. Play from each client with Speed-first, then Quality-first; watch PlaybackInfo order and the
   mesh log show the source choice and reasons. Kill the serving node mid-play; confirm failover.
5. Stop the relay after connections are up; confirm direct paths survive. Block UDP on one node;
   confirm relayed playback.
6. Pin the movie on node C; confirm the pointer entry disappears on C, the index shows two copies,
   and Quality-first prefers the closer one at equal quality.
7. From a phone on cellular, open the web UI at the node's public side-door hostname and confirm
   the padlock. Firewall inbound on that node; reload and confirm the client switched to the relay
   hostname with the padlock intact. Cast to a Chromecast at home and from away (manual checklist,
   no device available to agents).
8. CI: unit tests per crate/project, an integration test that spins up two nodes in Docker
   networks with simulated NAT and runs steps 1, 3, 4 and the side-door half of 7 headlessly.

---

## Risks and how the plan handles them

- **Coupling to Jellyfin internals** for the federated library (library manager, item repository,
  PlaybackInfo). Mitigated by using the standard `.strm`/`.nfo` resolver path for the items
  themselves, which has been stable for years and is exercised by the debrid ecosystem; only
  enrichment and MediaSource ordering touch internals, and both are listed in `docs/PATCHES.md`.
- ~~**Episode multi-version support** may be missing or partial on the vendored Jellyfin.~~
  **Closed in M3b:** verified working, with the check kept in `tools/e2e-m3.ps1` so an upstream pull
  that takes it away is noticed. See "What M3b settled".
- **Titles held both locally and remotely** show only the local copy in v1. Remote alternates are
  still used for dedupe, pin and same-hash failover; exposing them as extra versions of a local
  arr-managed file is deferred because arr treats `.strm` as video.
- **Expo web target for a native-heavy client** — gated spike at the top of M2 with a recorded
  fallback (Capacitor) that still keeps one UI codebase across web, phone and TV. M0 confirmed web
  support is absent upstream (no `react-dom`/`react-native-web`, no platform config at all), and
  separately that `npm install` needs both `--legacy-peer-deps` and `--ignore-scripts` on this
  toolchain before `yarn` was available — so the spike starts from zero rather than from a broken
  build, with the exact dependency-install path already mapped.
- **Mixed-version groups have no protocol negotiation.** The gossip frame size
  (`MAX_GOSSIP_MESSAGE`, 256 KiB) is a constant every member must share: a receiver on an older
  build rejects a larger frame, and the rejection is invisible on that side, so the *sender* goes
  silent to it while everything else keeps working. That is precisely the bug M4 found, and today
  the only mitigation is that nothing is deployed — restarting a stale node is the whole migration.
  Before anyone runs a build they cannot restart at will, gossip needs a version byte and a
  negotiated ceiling. On the list for M8, alongside member revocation.
- **Six upstream subtrees drifting** — monthly pull cadence, config-over-patch rule, and every
  patch listed in `docs/PATCHES.md`. Sonarr v5 is pre-release and will churn most.
- **iOS and TV constraints** — background networking and MPVKit acceptance are proven by
  Streamyfin being on the App Store and shipping TV builds; light-node re-sharing on iOS and TV is
  best-effort only and out of scope while iOS work is paused. Embedding iroh in the Android app
  relies on the Kotlin bindings restored in iroh 1.0.
- **Side door depends on DNS delegation and Let's Encrypt** — relay hosting gains one step (NS
  delegation) and two ports (53, 443). Let's Encrypt caps new certificates at 50 per registered
  domain per week, so a relay domain can onboard about 50 new nodes a week without a limit
  increase. Routers with DNS rebinding protection need a whitelist; the client detects and explains
  it. Relay operators see SNI hostnames but never plaintext or keys.
- **InfiniDysk streaming mode on Windows** needs a WebDAV mount (WinFsp/rclone) — kept optional
  and out of the critical path. Its native-library fetch step originally failed on this build
  machine's outdated bundled `curl`; fixed by installing a modern `curl` via winget ahead of it on
  `PATH` (see "Facts" above) — resolved, no longer a risk.
- **Name** — `.com`/`.net` status and trademark clearance for StingStream are unverified; Dan to
  check before registering or publishing store listings.
- **Legal posture** — content-agnostic, private groups only, no public directory by decision.
