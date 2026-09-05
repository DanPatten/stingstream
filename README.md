# StingStream

StingStream is a self-hosted media app that replaces the usual five-tool stack (Jellyfin for
playback, Radarr and Sonarr for grabbing, a remote-management app, and a download client) with one
install, one UI, and one login; every member of a group pools their libraries and downloads
automatically, playback picks the best available source across the group, and nodes reach each
other peer-to-peer through NAT with fallback to a self-hostable open-source relay. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design, decisions, repository layout,
and milestone plan, [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) for the handful of
conventions this shared checkout depends on, and [`NOTICE.md`](NOTICE.md) for the vendored
components and their licenses.

## Repository layout

```
StingStream/
├─ apps/stingstream/         # Expo app  (subtree: streamyfin/streamyfin)  web + mobile + TV
├─ server/jellyfin/          # subtree: jellyfin/jellyfin  + src/StingStream.Core (new)
├─ server/radarr/            # subtree: Radarr/Radarr
├─ server/sonarr/            # subtree: Sonarr/Sonarr
├─ server/infinidysk/        # subtree: nzbdav/nzbdav (optional usenet streaming)
├─ mesh/                     # Rust — TWO Cargo workspaces (see docs/ARCHITECTURE.md)
│  ├─ jellyswarrm/           # subtree: LLukas22/Jellyswarrm — its own Cargo workspace
│  └─ crates/                # mesh/Cargo.toml is the OTHER workspace, for these three:
│     ├─ stingstream/        # entry binary: supervisor + gateway
│     ├─ stingstream-mesh/   # iroh transport, groups, gossip index, source selection
│     └─ stingstream-relay/  # relay + discovery + storage-node profile
├─ packages/api-client/      # TS client generated from StingStream OpenAPI
├─ third_party/nzbget/       # fetch script for nzbgetcom binaries (not vendored)
├─ deploy/                   # Dockerfiles, compose, installers
├─ tools/                    # upstream-pull.ps1, build scripts
└─ docs/ARCHITECTURE.md      # living architecture doc
```

## Build commands

Each component builds independently today; there is no unified top-level build yet (that lands in
M1). From a clean clone:

```powershell
# .NET components -- each pins its own SDK feature band via its own global.json (or bare TFM for
# infinidysk, which has none); install all four side-by-side (the .NET SDK supports this):
#   server/jellyfin:   global.json pins SDK 10.0.0
#   server/radarr:     global.json pins SDK 8.0.421
#   server/sonarr:     global.json pins SDK 6.0.405
#   server/infinidysk: no global.json; all projects target net10.0
dotnet build server/jellyfin/Jellyfin.sln
dotnet build server/radarr/src/Radarr.sln
dotnet build server/sonarr/src/Sonarr.sln
dotnet build server/infinidysk/NzbWebDAV.sln

# Rust -- mesh/ is TWO separate Cargo workspaces, not one (see docs/ARCHITECTURE.md
# "Mesh workspace" for why unifying them was tried and doesn't work):
cargo build --manifest-path mesh/Cargo.toml            # stingstream, stingstream-mesh, stingstream-relay
$env:JELLYSWARRM_SKIP_UI = "1"                          # skips Jellyswarrm's optional embedded admin UI,
cargo build --manifest-path mesh/jellyswarrm/Cargo.toml # whose ui/ git submodule subtree never checks out

# StingStream app (Expo). Uses bun upstream (bun.lock committed); with npm, --legacy-peer-deps is
# needed (a plain `npm install` fails resolving the aliased react-native-tvos package against
# react-native-reanimated's peer range -- see docs/ARCHITECTURE.md). Web export is expected to
# fail until the M2 web-target spike; see docs/ARCHITECTURE.md "Risks" for why.
cd apps/stingstream
npm install --legacy-peer-deps   # or: bun install
npx expo export --platform web

# Fetch third-party NZBGet binaries (not vendored; downloaded on demand)
powershell -File third_party/nzbget/fetch-nzbget.ps1
```

To pull upstream changes into all six vendored subtrees, see `tools/upstream-pull.ps1`.

## License

New StingStream code is licensed **GPL-3.0-or-later** (see [`LICENSE`](LICENSE)). Vendored
components keep their own upstream licenses — see [`NOTICE.md`](NOTICE.md) for the full list.
