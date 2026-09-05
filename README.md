# StingStream

StingStream is a self-hosted media app that replaces the usual five-tool stack (Jellyfin for
playback, Radarr and Sonarr for grabbing, a remote-management app, and a download client) with one
install, one UI, and one login; every member of a group pools their libraries and downloads
automatically, playback picks the best available source across the group, and nodes reach each
other peer-to-peer through NAT with fallback to a self-hostable open-source relay. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design, decisions, repository layout,
and milestone plan, and [`NOTICE.md`](NOTICE.md) for the vendored components and their licenses.

## Repository layout

```
StingStream/
├─ apps/stingstream/         # Expo app  (subtree: streamyfin/streamyfin)  web + mobile + TV
├─ server/jellyfin/          # subtree: jellyfin/jellyfin  + src/StingStream.Core (new)
├─ server/radarr/            # subtree: Radarr/Radarr
├─ server/sonarr/            # subtree: Sonarr/Sonarr
├─ server/infinidysk/        # subtree: nzbdav/nzbdav (optional usenet streaming)
├─ mesh/                     # Rust workspace
│  ├─ jellyswarrm/           # subtree: LLukas22/Jellyswarrm
│  └─ crates/
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
# .NET components (requires the .NET SDK version each component's global.json pins)
dotnet build server/jellyfin/Jellyfin.Server
dotnet build server/radarr/src/Radarr.sln    # or the solution file present in server/radarr
dotnet build server/sonarr/src/Sonarr.sln    # or the solution file present in server/sonarr
dotnet build server/infinidysk

# Rust workspace (mesh/crates/*, plus mesh/jellyswarrm if the workspace includes it)
cargo build --manifest-path mesh/Cargo.toml

# StingStream app (Expo). Web export is expected to fail until the M2 web-target spike;
# see docs/ARCHITECTURE.md "Risks" for why.
cd apps/stingstream
npm install   # or yarn install, whichever lockfile is present upstream
npx expo export --platform web

# Fetch third-party NZBGet binaries (not vendored; downloaded on demand)
pwsh third_party/nzbget/fetch-nzbget.ps1
```

To pull upstream changes into all six vendored subtrees, see `tools/upstream-pull.ps1`.

## License

New StingStream code is licensed **GPL-3.0-or-later** (see [`LICENSE`](LICENSE)). Vendored
components keep their own upstream licenses — see [`NOTICE.md`](NOTICE.md) for the full list.
