# StingStream — architecture

This is the living architecture document for StingStream, kept current as the project evolves. It
started as the approved M0-through-M8 plan and is updated in place as decisions are made,
milestones land, and facts change; treat it as the source of truth for *why* things are built the
way they are, not just *what* exists today.

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
| Remote web and cast | An **HTTPS side door** next to the mesh, adapted from Plex's remote-access design (Dan, 2026-09-04): relay-hosted IP-reflecting DNS, a per-node Let's Encrypt wildcard certificate whose private key never leaves the node, UPnP/NAT-PMP/PCP port mapping, a relay reachability probe, SNI passthrough through the relay when direct fails, and connection racing in the web client and cast sender. |
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
  *episodes* on the vendored Jellyfin must be verified in M3 (fallback: one best version per
  episode). **JellyfinFederationPlugin** (C#, MIT, 71 stars, 8 commits) is a proof of concept of
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
works unchanged. Proven pattern from the debrid ecosystem; implemented in `StingStream.Core`.

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
   per-peer estimate, short probe range-fetch if stale) → quality fit against policy → source load.
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

### Relay server (`stingstream-relay`)

Docker image + single binary bundling `iroh-relay`, `iroh-dns-server` (pkarr discovery), the
IP-reflecting `direct.<relay-host>` DNS zone with its ACME challenge endpoint, and an SNI router on
443 in front of iroh-relay (all described under the HTTPS side door below). Runs on a small VPS
behind one hostname with NS delegation for its subdomain. Compose profile `storage-node` adds a
full StingStream node joined to the group so the relay host is also an always-on seedbox/cache.

### HTTPS side door (browsers, Chromecast, TV web views, 443-only networks)

The mesh serves the native apps. Anything that cannot speak iroh QUIC or verify a node-key
certificate — a browser away from home, a Chromecast receiver, a TV web view, or any client on a
network that only passes TCP 443 — uses a second door that ends in the same gateway. Adapted from
the Plex remote-access design with one change: private keys never leave the node.

1. **IP-reflecting DNS.** The relay is authoritative for `direct.<relay-host>` and decodes the
   leftmost label: `192-168-1-5.<nodeid>.direct.<relay-host>` answers `192.168.1.5` (IPv6 with
   dashes likewise). There are no records to maintain. The literal label `relay` answers with the
   relay's own public IP. Long TTLs, since the mapping is immutable.
2. **Per-node wildcard certificate.** Each node generates its own key and a CSR for
   `*.<nodeid>.direct.<relay-host>`, runs the ACME client itself (Let's Encrypt, DNS-01, Rust
   `instant-acme`), and asks the relay to publish the `_acme-challenge` TXT record through an
   endpoint only that node can write, with the request signed by its iroh key (the acme-dns
   pattern). Renewal at 60 days. The gateway serves the certificate with rustls on 8790 and,
   optionally, 443. The relay never holds a node's key.
3. **Port mapping.** The supervisor asks the router for a TCP mapping to the gateway via UPnP IGD,
   NAT-PMP or PCP, reusing iroh's `portmapper`. The result is shown on the Node status screen, with
   manual-rule instructions if all three fail.
4. **Reachability probe.** Over its existing iroh connection the node reports
   `{lan_ips, public_ip, mapped_port, cert_expiry}` to the relay. The relay attempts a real TLS
   handshake to the public hostname and records `direct_https: ok | blocked` in the node's
   discovery record, so clients learn the answer without first reaching the node.
5. **Relay passthrough when direct fails** (CGNAT, no UPnP, 443-only networks). The relay's 443
   listener dispatches by SNI: its own hostname goes to iroh-relay, and
   `relay.<nodeid>.direct.<relay-host>` becomes a raw TCP tunnel over iroh to that node's gateway.
   TLS still terminates on the node with the node's certificate, so the relay sees SNI and
   ciphertext only. Same certificate, three hostnames. Only nodes registered with that relay are
   routable, so the router cannot be used as an open proxy.
6. **Connection racing.** The web bundle and the cast sender read the candidate hostnames from the
   discovery record — LAN, public, relay — open all of them with a short timeout, keep the first
   that completes a TLS handshake, and remember the winner per network. LAN wins at home, public
   wins away, relay wins on hostile networks.
7. **Chromecast.** The sender hands the receiver the raced HTTPS URL. Cast receivers resolve
   through Google's public DNS, which our authoritative zone answers, so even the LAN hostname works
   from a receiver.
8. **DNS rebinding protection.** Some routers (OpenWrt dnsmasq, pfSense, Fritz!Box) drop public DNS
   answers that point at private IPs. The web client detects this (LAN name fails while the LAN IP
   is reachable), shows the one-line fix — whitelist `direct.<relay-host>` — and falls back to plain
   `http://<lan-ip>:8790` for LAN browsers with a visible warning.

Relay hosting therefore needs: a domain or subdomain with NS delegation to the relay host, UDP and
TCP 53, TCP 443 (the SNI router fronting iroh-relay), iroh's UDP address-discovery port, and a
Let's Encrypt account for the relay's own names. Still one box; the hosting guide walks through it.
Let's Encrypt allows 50 new certificates per registered domain per week and exempts renewals, so a
friend-group relay is comfortable; a large shared relay would request a rate-limit increase or add
ZeroSSL as a second CA.

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
Torznab stub (CI: MonoTorrent tracker seeding a Blender open movie) → downloaded by embedded
engine → imported → appears in Jellyfin → plays in stock jellyfin-web at `/jellyfin`. Same for a
series via Sonarr v5. Restart the machine: everything comes back on its own.

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

### M3 — Mesh v1: groups, relay, federated library, side door (Opus 5)

- `stingstream-mesh`: persisted node key; iroh endpoint with per-group relay; HTTP/1.1-over-QUIC
  server exposing the local gateway to authenticated peers (ALPN `stingstream/http/1`); peer
  client keyed by node ID; `iroh-gossip` topic per group carrying signed inventory snapshots and
  deltas plus heartbeats; SQLite `group_index`; `/stream/<group>/<item_key>/<node>` endpoint that
  proxies HTTP range requests to the named source node over iroh (single fixed source in M3;
  scoring and failover come in M4).
- Group lifecycle: create (ID, secret, relay URL), invite code, join via online member, leave,
  membership gossip, connection auth (group-secret proof + node signature).
- **Federated library v1 in `StingStream.Core`:** inventory publisher; Shared Movies / Shared TV
  libraries with NFO-only metadata; materialization of `.strm` + `.nfo` + images for titles not
  held locally, one version per holding node; MediaStream enrichment after refresh; offline-peer
  unavailable tagging with grace-period removal; PlaybackInfo hook returning `stingstream.local`
  MediaSources (unscored order in M3). Verify episode multi-version support on the vendored
  Jellyfin; record the result and fallback in this document.
- App: embedded iroh endpoint (Kotlin bindings; no Swift/iOS work) with the `stingstream.local` URL
  rewrite so MPV streams from the app's own mesh; Group screen (create/join/invite/members/relay);
  Settings → relay hostname field.
- `stingstream-relay`: Docker image + binary (iroh-relay + iroh-dns-server), `storage-node`
  compose profile, one-page hosting guide including the DNS delegation steps.
- **HTTPS side door, relay half:** authoritative IP-reflecting zone for `direct.<relay-host>`
  (including the `relay` label → own IP); signed-request TXT endpoint for ACME DNS-01; SNI router on
  443 fronting iroh-relay with per-node TCP passthrough over iroh, restricted to registered nodes;
  reachability probe writing `direct_https` into discovery records; the relay's own Let's Encrypt
  certificate.
- **HTTPS side door, node half:** ACME client (`instant-acme`) with the key generated and kept on
  the node; rustls on the gateway (8790, optional 443); `portmapper` TCP mapping for the gateway
  with the result and manual-rule fallback surfaced on Node status; side-door candidate hostnames
  published in the discovery record. Web bundle: connection racing across LAN, public and relay
  hostnames with the winner remembered per network.
- Install Docker Desktop and a JDK 17 + Android SDK on the build machine (not yet installed as of
  M0) as this milestone needs them.

**Accept:** two nodes behind different NATs (Dan's LAN + a VPS relay) join a group by invite. A
user on node A opens A's own Jellyfin through the app and sees B's titles in Shared Movies and
Shared TV with correct posters, overviews and resolution badges, and plays B's file direct while
A's mesh traffic counters show the bytes did not pass through A. Stop the relay after connection →
playback continues on the direct path. Block UDP hole-punching → playback still works via relay.
Block *all* UDP on a node → mesh traffic still flows through the relay on TCP 443. Take B offline →
its titles grey out on A within a minute and return when B does. From a phone on cellular, a
browser opens `https://<public-ip>.<nodeid>.direct.<relay-host>:8790` with a valid padlock and no
warning; firewall inbound on that node so it looks like CGNAT → the client races to the `relay.`
hostname and still gets a padlock, and the node's `direct_https` flips to `blocked` within a minute.

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
- **Episode multi-version support** may be missing or partial on the vendored Jellyfin. M3
  verifies; fallback is one best version per episode with failover handled inside the mesh
  `/stream` endpoint.
- **Titles held both locally and remotely** show only the local copy in v1. Remote alternates are
  still used for dedupe, pin and same-hash failover; exposing them as extra versions of a local
  arr-managed file is deferred because arr treats `.strm` as video.
- **Expo web target for a native-heavy client** — gated spike at the top of M2 with a recorded
  fallback (Capacitor) that still keeps one UI codebase across web, phone and TV. M0 confirmed web
  support is absent upstream (no `react-dom`/`react-native-web`, no platform config at all), and
  separately that `npm install` needs both `--legacy-peer-deps` and `--ignore-scripts` on this
  toolchain before `yarn` was available — so the spike starts from zero rather than from a broken
  build, with the exact dependency-install path already mapped.
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
