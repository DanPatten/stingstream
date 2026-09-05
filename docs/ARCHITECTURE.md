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

---

## Decisions locked in with Dan

| Topic | Decision |
|---|---|
| Sharing scope | Invite-based groups. Nothing leaves a group. A node can belong to several groups. No public directory. |
| Sharing module | Fork **Jellyswarrm** (LLukas22) — Rust reverse proxy that presents many Jellyfin servers as one, with user mapping, virtual libraries and full-proxy mode. |
| Downloads | Usenet and torrents, both **embedded**. External clients still allowed for existing setups. |
| Platforms at launch | Web (served by every node), iOS, Android, **Google TV / Android TV**. Apple tvOS later. |
| UI | **One codebase for all of them.** Expo app forked from Streamyfin (which already has TV variants), also built to web. |
| Node roles | Full nodes on Windows/macOS/Linux/Docker. Phones and TVs are light nodes: stream, phones download for offline and optionally re-share what they hold. |
| Playback | Direct-play the original over the mesh into MPV. Transcode at the source only as a bandwidth fallback. |
| Fork depth | Trackable forks as git subtrees in one monorepo. Minimal patches, pull upstream for a year or two, then cut the cord. |
| Arr merge | One service from the user's view, shared config, separate Radarr and Sonarr cores. |
| Identity | Username + password on your home node (Jellyfin accounts). Groups map users across nodes the Jellyswarrm way. |
| Replication | Single copy, stream from wherever it lives. Grabbers check the group index first. Any node can pin a library to mirror it. |
| Remote web and cast | An **HTTPS side door** next to the mesh, adapted from Plex's remote-access design (Dan, 2026-09-04): relay-hosted IP-reflecting DNS, a per-node Let's Encrypt wildcard certificate whose private key never leaves the node, UPnP/NAT-PMP/PCP port mapping, a relay reachability probe, SNI passthrough through the relay when direct fails, and connection racing in the web client and cast sender. |
| Roadmap features | Requests (Seerr-style), watch-together across the mesh, offline downloads, automatic subtitles, relay doubling as a storage node, Live TV/DVR passthrough. **Not** music/books, **not** a public directory. |

---

## Facts that constrain the design

Verified 2026-09-04 unless marked otherwise.

- **Jellyfin**: C#/.NET 10, ASP.NET. License is GPL-2.0-*or-later* per project lead (issue #8226,
  "effectively 2+"), though the vendored `LICENSE` file itself is plain GPL-2.0 text with no "or
  later" clause — see `NOTICE.md`. `jellyfin-web` is TypeScript/Webpack/Vite, GPL-2.0. Jellyfin can
  be run with `--nowebclient` so we can serve our own UI. **M0 finding:** requires .NET SDK
  `10.0.0` per `global.json` (`rollForward: latestMinor`); this machine only has 9.0.310 installed,
  so the M0 build attempt failed on SDK resolution, not compile errors.
- **Radarr / Sonarr**: .NET backends, React/TypeScript frontends, GPL-3.0. Both descend from
  NzbDrone and share identical `NzbDrone.*` namespaces and heavy static state, so they cannot
  share one process without AssemblyLoadContext isolation that would wreck upstream tracking.
  They run as child processes; the "one process" the user sees is the supervisor. **M0 finding:**
  Radarr pins SDK `8.0.421`, Sonarr pins SDK `6.0.405` (both via `global.json`); neither is
  installed on the M0 build machine (only 9.0.310), so both builds failed on SDK resolution.
  **M0 finding:** Sonarr's repository default branch (`HEAD`) is `v5-develop` (a newer major
  version in active development), not `develop` — the plan named `develop`, which does exist as a
  separate, older branch and was vendored literally as authorized. This is flagged for Dan; see
  "Milestones" → M0 below.
- **nzb360**: proprietary, and removed from Google Play on 2026-08-13. Cannot be forked; UX
  reference only. LunaSea (open-source equivalent) archived April 2025.
- **Jellyswarrm**: Rust, Axum 0.8, SQLx/SQLite, reqwest, ships a `jellyfin-api` crate. Early-stage:
  no WebSocket proxying (blocks SyncPlay), no bitrate adaptation, no media management. Presents as
  a standard Jellyfin server so Jellyfin clients (including Streamyfin) work unchanged against it.
  **M0 finding — licensing is more nuanced than a single GPL-2.0 badge:** the repository's
  top-level `LICENSE` is the *unfilled* GPL-2.0 (June 1991) FSF template (still containing literal
  `{{description}}`/`{{year}}`/`{{fullname}}` placeholders) and its README badge links specifically
  to the GPL-2.0-only "old-licenses" page — no "or later" wording anywhere at the top level. But
  the three actual Rust crates that make up the buildable project
  (`jellyswarrm-proxy`, `jellyswarrm-macros`, `jellyfin-api`) each declare
  `license = "MIT OR Apache-2.0"` in their own `Cargo.toml` and ship real, filled-in
  `LICENSE-MIT`/`LICENSE-APACHE` files. The code we are actually forking is MIT/Apache-2.0, not
  GPL. Full detail and exact quotes in `NOTICE.md`.
  **M0 finding — vendoring is blocked:** the repo tracks its dev/demo fixture media
  (`dev/media/**/*.mp4`, `*.ogg`) via Git LFS, and `git-lfs` isn't installed on the M0 build
  machine, so `git subtree add` aborted before its merge commit (see "Milestones" → M0 below for
  the recovery options this needs Dan to pick between). All 174 non-media files — everything that
  actually matters for the fork — fetched and checked out cleanly, and the license/build findings
  above were read from that content directly.
  **M0 finding — mesh workspace split:** Jellyswarrm's three crates use Cargo workspace-inheritance
  (`field.workspace = true`) for `version`/`authors`/`repository` and for a ~40-entry
  `[workspace.dependencies]` table (axum, sqlx, tokio, reqwest, etc., all pinned in its own
  `Cargo.toml`). Re-rooting them under `mesh/Cargo.toml` as a single unified workspace was tried
  and fails: first on the missing `version`/`authors`/`repository` inheritance (fixable), then on
  every one of its ~40 dependency-inheritance references (`workspace.dependencies` undefined at
  the new root) — fixing that would mean copying Jellyswarrm's entire dependency table into our
  own workspace manifest, permanently re-coupling the new `stingstream*` crates' dependency
  versions to whatever Jellyswarrm pins, and guaranteeing a conflict the first time either side
  needs a different version of something the other already pins. Per the plan's explicit fallback,
  **mesh/ is two separate Cargo workspaces**: the root `mesh/Cargo.toml` (the three new
  `stingstream*` crates) and `mesh/jellyswarrm/Cargo.toml` (Jellyswarrm's own, untouched). Each
  builds independently (`cargo build --manifest-path mesh/Cargo.toml` /
  `cargo build --manifest-path mesh/jellyswarrm/Cargo.toml`, or `cd` into either and
  `cargo build`); CI runs both. See `mesh/Cargo.toml` for the same note in context.
  **M0 finding — jellyswarrm-proxy's embedded UI build:** its `build.rs` shells out to `git` inside
  a `ui/` git submodule (Jellyswarrm's own admin UI, a `jellyfin-web` checkout) to stamp a commit
  hash; a plain `git subtree add`/`pull` never initializes submodules, so `ui/` doesn't exist on
  disk and the build panics. The crate has a documented escape hatch,
  `JELLYSWARRM_SKIP_UI=1`, which skips the npm/yarn UI build — but that alone still fails to
  compile, because `#[derive(RustEmbed)] #[folder = "static/"] struct Asset;` in
  `crates/jellyswarrm-proxy/src/main.rs` needs that folder to exist at compile time for the derive
  macro to implement the `Embed` trait (missing folder → `Asset` compiles but is missing `get()`).
  Creating an empty `static/` directory alongside `JELLYSWARRM_SKIP_UI=1` gets past this. Not
  committed as a patch during M0 (no source file was changed, only an untracked empty directory
  used to validate the build) — worth turning into a documented, tracked accommodation
  (`docs/PATCHES.md`, once it exists) whenever CI or a contributor needs this crate to build
  without running the embedded UI's own build step. We do not need Jellyswarrm's bundled admin UI
  at all — StingStream's own UI comes from `apps/stingstream` (Streamyfin).
- **iroh 1.0** (June 2026): Rust, QUIC, ~90% direct hole-punch rate, encrypted stateless relays,
  relay binary open source and self-hostable, MIT/Apache. FFI for Swift, Kotlin, Node, Python.
  `iroh-gossip` (topic pubsub) and `iroh-blobs` (BLAKE3-verified range transfer) are companion
  crates. `iroh-h3` exists for serving Axum over iroh.
- **iroh connectivity details**: iroh's `portmapper` crate already tries UPnP, NAT-PMP and PCP to
  raise direct-connect odds, and relay traffic rides TLS on TCP 443, so UDP-hostile networks still
  work through the relay. None of that helps a browser or a Chromecast receiver: they cannot speak
  iroh and will only trust a hostname with a publicly trusted certificate. That is what the HTTPS
  side door (see "Architecture" below) exists for.
- **Streamyfin**: Expo + React Native, TypeScript, MPV via MPVKit, ffmpeg-based offline downloads,
  Seerr integration, iOS/Android/tvOS/Android TV (`:tv` build variants). MPL-2.0 (GPL-compatible),
  confirmed against `apps/stingstream/LICENSE.txt`. No web target today. **M0 finding:** default
  branch is `develop` (the plan named `master`, which does not exist upstream — substituted per
  the M0 branch rule; see "Milestones" → M0). Uses `bun` as its package manager (`bun.lock`
  committed); `bun` isn't installed on the M0 build machine. `npm install` alone fails on a peer
  dependency resolution error between the aliased `react-native-tvos` package and
  `react-native-reanimated`'s peer range (npm's resolver doesn't recognize the alias as satisfying
  the range; `bun`'s resolver is more permissive about exactly this) — `--legacy-peer-deps` gets
  past that. Deeper than that: a git-sourced transitive dependency
  (`react-native-track-player@4.1.1`) has an npm `prepare` lifecycle script that shells out to
  `yarn build`, and `yarn` isn't installed either, so even `npm install --legacy-peer-deps` fails
  to complete and `node_modules` never populates — see the M0 build report for the exact output and
  what this blocks.
- **Embedded download engines**: MonoTorrent 3.x (.NET, MIT, BitTorrent v2) for torrents.
  NZBGet fork `nzbgetcom/nzbget` (C++, GPL-2.0, maintained, prebuilt binaries for Windows, macOS,
  Linux incl. ARM) for full-to-disk usenet — not vendored as a subtree, fetched on demand by
  `third_party/nzbget/fetch-nzbget.ps1` (latest release checked during M0: v26.3). InfiniDysk /
  `nzbdav/nzbdav` (.NET 10, MIT, maintained) for optional stream-from-usenet mode via WebDAV.

**Licensing outcome**: everything is combinable. New StingStream code is GPL-3.0-or-later. The mesh
binary (contains Jellyswarrm) is GPL-2.0-or-later so it stays distributable even if Jellyswarrm
turns out to be GPL-2-only. Radarr/Sonarr/NZBGet stay in their own processes under their own
licenses. **M0 update:** the GPL-2-only worst case this hedge was written for turned out not to be
the case — Jellyswarrm's actual crates are MIT/Apache-2.0 (see above) — so the GPL-2.0-or-later
choice for the mesh binary is now a conservative choice rather than a necessary one. Left as-is
pending Dan's call; see `NOTICE.md`.

---

## Architecture

### One node = one install = five processes behind one door

```
                 ┌──────────────────────────────────────────────────────────┐
  App (web/iOS/  │  stingstream  (Rust)   port 8790                          │
  Android/TV) ─► │  ├─ gateway: serves web bundle, routes /stingstream/*,    │
                 │  │   and presents the Jellyswarrm virtual Jellyfin API   │
                 │  ├─ mesh: iroh endpoint, groups, gossip index, source     │
                 │  │   selection, HTTP-over-QUIC to peer nodes              │
                 │  └─ supervisor: spawns, monitors, restarts children       │
                 └───┬──────────────┬──────────────┬─────────────┬──────────┘
                     │ localhost    │              │             │
          ┌──────────▼──────────┐ ┌─▼──────┐ ┌─────▼─────┐ ┌────▼─────┐  ┌──────────────┐
          │ jellyfin (fork)     │ │ radarr │ │  sonarr   │ │  nzbget  │  │ infinidysk   │
          │ + StingStream.Core: │ │ (fork) │ │  (fork)   │ │ (binary) │  │ (optional)   │
          │   Omniarr sync,     │ └────────┘ └───────────┘ └──────────┘  └──────────────┘
          │   MonoTorrent,      │
          │   inventory, hooks, │
          │   requests          │
          └─────────────────────┘
```

- **`stingstream`** (Rust, entry binary): the only exposed port. Fork of Jellyswarrm plus new
  crates. Children bind localhost on supervisor-assigned ports written to
  `$STINGSTREAM_DATA/runtime.json`.
- **`StingStream.Core`** (new .NET project inside the Jellyfin fork, registered in `Jellyfin.Server`
  startup): lives in Jellyfin's process to get `ILibraryManager` for inventory and refresh triggers,
  and to reuse Jellyfin's auth for the StingStream API at `/stingstream/api/v1/*`.
- **Radarr / Sonarr forks**: aim for zero code patches. Supervisor pre-seeds `config.xml`
  (API key, port, bind address, UrlBase, auth method). Their UIs are simply not routed by the gateway.
- **Config sync ("Omniarr" — internal name only)**: one shared model (indexers, download clients,
  quality profiles, root folders, naming, notifications) pushed into both cores via their v3 APIs.
  Same pattern Prowlarr uses.
- **Downloaders**: MonoTorrent runs in-process behind a **qBittorrent-compatible API subset**
  (login, app/version, app/webapiVersion, torrents/info, add, delete, properties, files, setCategory)
  so the arr cores use it unmodified. NZBGet runs as a bundled child with its native API. InfiniDysk
  optional (SABnzbd-compatible API, streaming mode) — later milestone.

### Groups, identity, federation

- **Node identity** = iroh keypair, persisted in `$STINGSTREAM_DATA/node.key`.
- **Group** = 32-byte group ID (also the gossip topic) + group secret + relay URL. The relay is a
  property of the group, so members auto-configure it from the invite.
- **Invite code** = base58(group ID, secret, inviter node address, relay URL). Joining requires the
  inviter (or any member) online in v1. Revocation in v1 = secret rotation; proper member revocation
  in M8.
- **Users** = Jellyfin accounts on the person's home node. Jellyswarrm's "Server Federation" syncs
  users across connected servers; the mesh creates mapped accounts on peer nodes and maps tokens.
  Login anywhere in the group authenticates against the home node.
- **Content identity** = provider IDs (tmdb/tvdb/imdb + season/episode) for "same title", plus a
  BLAKE3 file hash computed on import for "same file". Both live in the inventory record.

### Inventory and group index

Each node's `StingStream.Core` publishes `{node, item_key, jellyfin_item_id, media summary (res,
codec, bitrate, size, duration), file_hash, updated_at}` plus a heartbeat `{max_direct_streams,
max_transcodes, active counts, free space}`. Mesh broadcasts signed snapshots + deltas over
`iroh-gossip` and keeps a SQLite `group_index`. Used for virtual-library merge hints, grab
dedupe, and source selection.

### Playback path

1. App asks the virtual Jellyfin API (gateway) for PlaybackInfo.
2. Mesh collects candidates from `group_index` by item_key, scores them:
   connectivity (direct beats relayed, RTT from iroh path info) → measured throughput (rolling
   per-peer estimate, short probe range-fetch if stale) → quality fit against policy → source load.
3. Policy is a user setting: **Speed first** (default: best quality that fits bandwidth with margin)
   or **Quality first** (highest quality; transcode at source if it doesn't fit). Per-play override
   "Play from…" lists nodes.
4. Direct-play: file bytes flow source Jellyfin → source mesh → iroh (direct or relayed) → viewer
   mesh → MPV (native, incl. TV) or `<video>` (web). HTTP/1.1 range requests over a dedicated QUIC
   bidi stream per request, ALPN `stingstream/http/1`.
5. Fallback: mesh requests HLS transcode from the source node's Jellyfin with a max bitrate and
   proxies it.
6. Failover: same file hash elsewhere → resume by byte offset. Different file → resume by timestamp.

### Grab / add / request flow

1. User adds a title (or a member requests one) via the StingStream API.
2. `StingStream.Core` asks the mesh for `group_index` matches at acceptable quality.
3. Present → mark "available via group", optionally add to arr **unmonitored** for metadata and
   future upgrades. **No download.**
4. Absent → add to the fulfilling node's arr core (requester's home node by default; else a
   volunteer node with matching indexers and free space) as monitored → grab → embedded engine →
   import → arr webhook → Jellyfin refresh → inventory publish → visible group-wide within seconds.
5. **Pin/mirror**: node fetches the file over iroh (resumable HTTP range) into its own root folder,
   imports it, and now the index shows two copies.

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

Fork of Streamyfin. Targets web (react-native-web via Expo), iOS, Android, and Android TV /
Google TV (Streamyfin's existing `:tv` variant); Apple tvOS later. Player abstraction: MPV on
native and TV, `<video>` + hls.js on web. Server URL is always the user's own node; the virtual API
makes the whole group appear as one server. New screens: **Manage** (movies/series wanted, calendar,
queue, history), **Downloads**, **Server settings** (indexers, engines, quality profiles, root
folders, naming), **Group** (nodes, members, invites, relay, storage), **Requests** (adapted from
Streamyfin's Seerr screens), **Admin** (users, libraries, scan, transcoding, logs), **Node status**.
The TV build gets the browse/play/requests surface with D-pad focus handling; management screens
stay phone/web-only. Native builds reach nodes over the mesh; the web bundle and the cast sender use
the HTTPS side door with connection racing. Stock jellyfin-web, Radarr, Sonarr and NZBGet UIs are
never the front door.

---

## Repository layout

```
StingStream/
├─ apps/stingstream/         # Expo app  (subtree: streamyfin/streamyfin)  web + mobile + TV
├─ server/jellyfin/          # subtree: jellyfin/jellyfin  + src/StingStream.Core (new)
├─ server/radarr/            # subtree: Radarr/Radarr
├─ server/sonarr/            # subtree: Sonarr/Sonarr
├─ server/infinidysk/        # subtree: nzbdav/nzbdav (optional usenet streaming)
├─ mesh/                     # Rust — TWO workspaces (see "Mesh workspace" finding above)
│  ├─ jellyswarrm/           # subtree: LLukas22/Jellyswarrm — its own Cargo workspace
│  └─ crates/                # this directory's parent mesh/Cargo.toml is the OTHER workspace
│     ├─ stingstream/        # entry binary: supervisor + gateway
│     ├─ stingstream-mesh/   # iroh transport, groups, gossip index, source selection
│     └─ stingstream-relay/  # relay + discovery + direct DNS zone + SNI router + storage-node profile
├─ packages/api-client/      # TS client generated from StingStream OpenAPI
├─ third_party/nzbget/       # fetch script for nzbgetcom binaries (not vendored)
├─ deploy/                   # Dockerfiles, compose, installers
├─ tools/                    # upstream-pull.ps1, build scripts
└─ docs/ARCHITECTURE.md      # this document
```

Upstream tracking: `git subtree add --prefix ... --squash` per repo, `tools/upstream-pull.ps1`
to `git subtree pull` all six. Patches land directly in the subtree directories; keep them
config-driven where a code patch can be avoided.

---

## Milestones

Each package: **model → deliverables → acceptance**. Packages inside a milestone can run in
parallel where noted.

### M0 — Repo, vendoring, builds green (Sonnet 5)

- Monorepo skeleton above; subtrees for the six upstreams; `tools/upstream-pull.ps1`.
- Unmodified builds: `dotnet build` (jellyfin, radarr, sonarr, infinidysk), `cargo build`
  (jellyswarrm, and the three new crates), `npx expo export --platform web` (fails today — record
  why, feeds M2 spike), Streamyfin `:tv` Android build.
- GitHub Actions matrix for the three toolchains. LICENSE/NOTICE per component. `docs/ARCHITECTURE.md`.
- Verify Jellyswarrm LICENSE wording; record result in NOTICE.

**Accept:** clean clone → documented commands build every component on Windows and Linux CI.

**M0 status (2026-09-04):** repo skeleton, tools, CI and docs committed; five of six subtrees
landed clean (streamyfin, jellyfin, radarr, sonarr, infinidysk); the sixth (jellyswarrm) fetched
successfully but is blocked mid-`git subtree add` on a missing `git-lfs` binary needed for its
dev-fixture media (see "Facts" above and `NOTICE.md`) — needs Dan to choose a recovery path.
Two open items need Dan's decision:
1. **Sonarr branch** — vendored `develop` exactly as authorized, but the repo's actual default
   branch (`HEAD`) is `v5-develop`, a newer major-version line. Keep `develop`, or re-vendor from
   `v5-develop`?
2. **Jellyswarrm subtree recovery** — install `git-lfs` and retry the `git subtree add` cleanly
   (cleanest), or authorize a specific one-off recovery command against the current partial state
   (e.g. finalizing the currently-staged tree, which already excludes only the irrelevant
   dev-fixture media)?

No component's `dotnet build` succeeded on this machine — all four fail purely on missing SDK
versions (`global.json` pins jellyfin to `10.0.0`, radarr to `8.0.421`, sonarr to `6.0.405`;
infinidysk targets `net10.0` with no `global.json`), and only SDK `9.0.310` (plus ancient
`1.0.4`/`2.1.100`) is installed. `cargo build` for the three new `stingstream*` crates and (once
unblocked, plus `JELLYSWARRM_SKIP_UI=1` and an empty `static/` dir — see "Facts" above) Jellyswarrm
both succeed independently as two workspaces. See the M0 build report for exact command output and
the Expo web export findings.

### M1 — One-node "one app" server (Opus 5)

- `mesh/crates/stingstream`: supervisor (spawn/monitor/restart, unified structured logs, single
  `STINGSTREAM_DATA`), gateway on 8790 routing `/` (placeholder page for now), `/jellyfin/*` →
  local Jellyfin, `/stingstream/api/*` → StingStream.Core.
- `server/jellyfin/src/StingStream.Core`: registered in Jellyfin startup; OpenAPI at
  `/stingstream/api/v1/openapi.json`; Omniarr sync service; MonoTorrent engine + qBittorrent API
  subset; NZBGet lifecycle + auto-registration; arr webhook receiver → targeted Jellyfin refresh;
  BLAKE3 hashing on import (background, throttled).
- Radarr/Sonarr: config.xml pre-seeding, localhost binding, API keys from supervisor. Zero code
  patches unless unavoidable — document any.
- First-run wiring: root folders `Movies/` and `TV/`, both download engines registered in both
  arrs, Jellyfin libraries created, webhooks installed.

**Accept:** fresh machine → one command → add a movie via `/stingstream/api/v1` → grabbed from a
Torznab stub (CI: MonoTorrent tracker seeding a Blender open movie) → downloaded by embedded
engine → imported → appears in Jellyfin → plays in stock jellyfin-web at `/jellyfin`. Same for a
series via Sonarr. Restart the machine: everything comes back on its own.

### M2 — Unified UI v1 on one node (Sonnet 5; web-target spike by Opus 5 first)

- **Spike (Opus, gate):** Streamyfin fork builds for web with a player abstraction (MPV native
  untouched, `<video>` + hls.js on web), native-only modules shimmed, and the existing `:tv`
  variant still builds. Time-box it. If web fails, the fallback that still honours "one UI" is a
  web-first React app wrapped in Capacitor with a native player plugin and a TV shell — decision
  recorded in this document before screens start.
- `packages/api-client` generated from the StingStream OpenAPI.
- Screens: Manage, Downloads, Server settings, Admin essentials, Node status (Group/Requests wait
  for M3/M6). Reuse Streamyfin's existing Jellyfin screens as-is. TV variant: browse/play only,
  D-pad focus verified on an Android TV emulator.
- Gateway serves the web bundle at `/`; Jellyfin started with `--nowebclient`.

**Accept:** every M1 action doable from the StingStream UI in a browser and in dev builds on an
Android device and an iPhone, without ever opening a Jellyfin, Radarr, Sonarr or NZBGet page.
Browse and play works on an Android TV emulator with a remote.

### M3 — Mesh v1: groups, relay, federation (Opus 5)

- `stingstream-mesh`: persisted node key; iroh endpoint with per-group relay; HTTP/1.1-over-QUIC
  server exposing the local gateway to authenticated peers (ALPN `stingstream/http/1`); client
  connector keyed by node ID for Jellyswarrm upstreams (replace reqwest with hyper + custom connector).
- Jellyswarrm wiring: upstream list ← group members; user federation on; virtual libraries
  auto-merge by type; full-proxy mode on. Gateway now serves the virtual Jellyfin API at `/`.
- Group lifecycle: create (ID, secret, relay URL), invite code, join via online member, leave,
  membership gossip, connection auth (group-secret proof + node signature).
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
  published in the discovery record.
- App: Group screen (create/join/invite/members/relay), Settings → relay hostname field. Web bundle:
  connection racing across LAN, public and relay hostnames with the winner remembered per network.

**Accept:** two nodes behind different NATs (Dan's LAN + a VPS relay) join a group by invite. A
user created on node A logs in through A's UI and sees B's library merged and plays B's file
direct. Stop the relay after connection → playback continues on the direct path. Block UDP
hole-punching → playback still works via relay. Block *all* UDP on a node → mesh traffic still
flows through the relay on TCP 443. From a phone on cellular, a browser opens
`https://<public-ip>.<nodeid>.direct.<relay-host>:8790` with a valid padlock and no warning; then
firewall inbound on that node so it looks like CGNAT → the client races to the `relay.` hostname and
still gets a padlock, and the node's `direct_https` flips to `blocked` within a minute.

### M4 — Shared downloads, group index, source selection (Opus 5)

- Inventory publisher in `StingStream.Core` → mesh local API → gossip (signed, snapshot + deltas,
  heartbeat with capacity). `group_index` SQLite in mesh.
- Dedupe in add/request flow; "available via group" state in UI; pin/mirror fetch over iroh into a
  local root folder → import.
- Source-selection engine: candidate scoring, Speed-first / Quality-first setting, per-play
  override, capacity limits, mid-stream failover, HLS transcode fallback proxied from source.
- Concurrency: N viewers on M sources at once; a node's advertised limits are respected.

**Accept:** same movie on B (1080p) and C (4K). Viewer on A with Speed-first on a throttled link
gets B; Quality-first gets C, or C's transcode when the link is too slow. Kill B mid-play →
resumes from C within about 5 seconds. Adding a movie already on B from A triggers no download.
Pinning it on A copies it and the index shows two sources. Three viewers streaming three
different files from B simultaneously all play.

### M5 — Mobile and TV release readiness, offline (Sonnet 5)

- Production iOS, Android and Android TV builds (EAS or local), branding, QuickConnect across the
  mesh (TV logs in by approving a code on a phone), mesh-aware source choice for offline downloads,
  background downloads, TV ten-foot polish (focus, remote shortcuts, resume).
- Chromecast over the HTTPS side door: the sender races LAN/public/relay hostnames and hands the
  receiver the winner. DNS-rebinding detection with the whitelist hint and plain-HTTP LAN fallback on
  the Node status screen. Any TV web view uses the trusted side-door URL.

**Accept:** TestFlight build, signed phone APK and signed TV APK. Download an episode from a peer
node, go to airplane mode, play it. On a Google TV device: pair via QuickConnect, browse the
merged library, play a peer's file with the remote. Cast a peer's file to a Chromecast from the
phone at home (LAN hostname) and from cellular (public or relay hostname) with no certificate
prompt on either.

### M6 — Requests (Sonnet 5)

- Requests service in `StingStream.Core` (requests, approvals, group policy auto-approve / by
  role), routing to a fulfilling node (home node, else volunteer by indexers + free space), in-app
  and Jellyfin notifications. App: adapt Streamyfin's Seerr screens to the StingStream requests API.

**Accept:** a non-admin on node A (no usenet) requests a series; node B fulfils it; it appears for
everyone; requester is notified.

### M7 — Watch-together, subtitles, Live TV, storage-node polish (Opus 5 for SyncPlay; Sonnet 5 for the rest)

- WebSocket proxying in gateway/mesh (Jellyswarrm's gap) → SyncPlay coordinator living in the
  mesh so sessions span nodes.
- Subtitles: Jellyfin OpenSubtitles plugin on by default; group-wide "wanted languages" job that
  fetches once and publishes via inventory.
- Live TV/DVR: proxy tuner/guide/recording endpoints; recordings enter inventory.
- Relay `storage-node` profile hardened and documented.

**Accept:** two members on different nodes watch in sync with under 1 s drift. New import gets
subtitles in the group's languages within a scan cycle. A DVR recording on B plays on A's TV.

### M8 — Packaging, updates, hardening (Sonnet 5, then `/security-review`)

- Installers: Windows (winget/MSIX), macOS pkg, Linux deb + AppImage, Docker. Self-contained .NET
  publish, Rust binary, NZBGet binary bundled. Update channel. Play Store listings for phone and TV.
- Security: member revocation and group key rotation, token-mapping audit, rate limits, localhost
  binding audit for all children, dependency audit. Side door specifically: the TXT endpoint accepts
  only requests signed by the node that owns the name, the SNI router routes only registered nodes,
  probe requests are rate-limited, certificate keys on the node are file-permission restricted, and
  the gateway sends HSTS. Upstream pull cadence documented (monthly).

**Accept:** install on a clean Windows box and a clean Ubuntu box from the release page; both
join a group with one code; `/security-review` findings triaged.

---

## Verification (end-to-end, after M4)

1. Three nodes: Dan's Windows desktop, a Linux Docker host, a VPS running `stingstream-relay` with
   the `storage-node` profile. Create the group on the desktop, join the others by invite.
2. Two users, one per home node, log in from the web UI, an Android device, an iPhone and a
   Google TV.
3. Add a public-domain movie on node A; confirm it downloads once (embedded torrent engine) and
   appears on all clients within a minute. Add the same title from node B; confirm no second
   download.
4. Play from each client with Speed-first, then Quality-first; watch the mesh log show the source
   choice and reasons. Kill the serving node mid-play; confirm failover.
5. Stop the relay after connections are up; confirm direct paths survive. Block UDP on one node;
   confirm relayed playback.
6. Pin the movie on node C; confirm the index shows two copies and Quality-first prefers the
   closer one at equal quality.
7. From a phone on cellular, open the web UI at the node's public side-door hostname and confirm
   the padlock. Firewall inbound on that node; reload and confirm the client switched to the relay
   hostname with the padlock intact. Cast to a Chromecast at home and from away.
8. CI: unit tests per crate/project, an integration test that spins up two nodes in Docker
   networks with simulated NAT and runs steps 1, 3, 4 and the side-door half of 7 headlessly.

---

## Risks and how the plan handles them

- **Expo web target for a native-heavy client** — gated spike at the top of M2 with a recorded
  fallback (Capacitor) that still keeps one UI codebase across web, phone and TV. M0 has already
  surfaced two concrete blockers ahead of that spike: `bun`-only dependency resolution (npm needs
  `--legacy-peer-deps`, and even then a git-sourced dependency's `prepare` script needs `yarn`,
  which isn't installed) and whatever `npx expo export --platform web` reports once that's
  resolved — see the M0 build report for specifics feeding directly into the M2 spike.
- **Jellyswarrm is early-stage** — we own the fork; WebSocket proxying and adaptive source
  choice are explicit milestones (M7, M4).
- **"One process" for the arr cores** — delivered as one service, one config, one UI. Cores stay
  child processes because of identical NzbDrone namespaces and static state. Revisit only if a
  concrete need appears.
- **Six upstream subtrees drifting** — monthly pull cadence, config-over-patch rule, and every
  patch listed in `docs/PATCHES.md` (create this file when the first patch lands).
- **Mesh workspace split** — building `mesh/crates/*` and `mesh/jellyswarrm` as two Cargo
  workspaces (confirmed necessary during M0, see "Facts" above) means CI and `tools/` scripts must
  always address both explicitly; there is no single `cargo build` at `mesh/` that covers both.
- **.NET SDK version spread** — jellyfin/radarr/sonarr/infinidysk each pin a different SDK feature
  band (10.0.0 / 8.0.421 / 6.0.405 / net10.0 respectively) via their own `global.json`/TFM. A
  contributor or CI machine needs all of them side-by-side (the .NET SDK supports this natively);
  M0 found only one SDK installed on the reference machine, so no component builds there yet.
- **iOS and TV constraints** — background networking and MPVKit acceptance are proven by
  Streamyfin being on the App Store and shipping TV builds; light-node re-sharing on iOS and TV is
  best-effort only.
- **Side door depends on DNS delegation and Let's Encrypt** — relay hosting gains one step (NS
  delegation) and two ports (53, 443). Let's Encrypt caps new certificates at 50 per registered
  domain per week, so a relay domain can onboard about 50 new nodes a week without a limit
  increase. Routers with DNS rebinding protection need a whitelist; the client detects and explains
  it. Relay operators see SNI hostnames but never plaintext or keys.
- **InfiniDysk streaming mode on Windows** needs a WebDAV mount (WinFsp/rclone) — kept optional
  and out of the critical path.
- **Name** — `.com`/`.net` status and trademark clearance for StingStream are unverified; Dan to
  check before registering or publishing store listings.
- **Legal posture** — content-agnostic, private groups only, no public directory by decision.
