# Developing StingStream

This page carries the developer-facing material that used to live in the README. The README is
now written for people who install StingStream; this is for people who build it.

Start with [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it fits together, [`RUNNING.md`](RUNNING.md)
for running a node from a checkout, and [`CONTRIBUTING.md`](CONTRIBUTING.md) for the six
conventions that keep a shared checkout working.

## Repository layout

```
StingStream/
├─ apps/stingstream/         # Expo app  (subtree: streamyfin/streamyfin)  web + phone + TV
├─ server/jellyfin/          # subtree: jellyfin/jellyfin  + src/StingStream.Core (ours)
├─ server/radarr/            # subtree: Radarr/Radarr
├─ server/sonarr/            # subtree: Sonarr/Sonarr  (v5-develop)
├─ server/infinidysk/        # subtree: nzbdav/nzbdav  (optional usenet streaming, not wired up)
├─ mesh/                     # Rust — TWO Cargo workspaces (see ARCHITECTURE.md)
│  ├─ jellyswarrm/           # subtree: LLukas22/Jellyswarrm — reference only, its own workspace
│  └─ crates/                # mesh/Cargo.toml is the OTHER workspace
│     ├─ stingstream/        # entry binary: supervisor + gateway + side door
│     ├─ stingstream-mesh/   # iroh transport, groups, gossip index, source selection
│     ├─ stingstream-mesh-ffi/ # uniffi bindings, for the app's embedded light node
│     └─ stingstream-relay/  # the coordinator: relay, rendezvous, DNS, SNI router
├─ packages/api-client/      # TS client generated from the StingStream OpenAPI document
├─ third_party/              # nzbget and jellyfin-ffmpeg fetch scripts (not vendored)
├─ deploy/                   # installers, Docker, compose, Play Store listing
├─ tools/                    # e2e-m*.ps1 acceptance harnesses, upstream-pull.ps1, packaging
└─ docs/                     # everything linked from here
```

## Building it

```powershell
# The node: Rust supervisor + mesh, and the Jellyfin fork that carries StingStream.Core.
cargo build --manifest-path mesh/Cargo.toml
dotnet build server/jellyfin/Jellyfin.Server/Jellyfin.Server.csproj

# The arrs, which we do not patch (see PATCHES.md) -- each pins its own SDK band in its
# own global.json, and the .NET SDK installs side by side.
dotnet build server/radarr/src/Radarr.sln     # SDK 8
dotnet build server/sonarr/src/Sonarr.sln     # SDK 10

# The app. bun only -- yarn's hoisting introduces a second react-native-screens that crashes
# Android at startup, which no bundler check catches. CONTRIBUTING.md rule 5.
cd apps/stingstream && bun install && bun run typecheck && bun test
```

Then `pwsh tools/e2e-m1.ps1 -PrivateCopy` for one node end to end, or any of `e2e-m3` (two nodes
and a federated library), `e2e-m4` (source selection and failover), `e2e-m6` (requests), `e2e-m7`
(watch together, subtitles, recordings), `e2e-m8` (revocation) and `e2e-sidedoor` (ACME and the
HTTPS side door). Each one starts real nodes and asserts against them; none of them mocks the
sharing path. Full instructions, including the private-build-copy dance that lets several people
work in one checkout, are in [`RUNNING.md`](RUNNING.md).

## Where things are documented

| Topic | Document |
|---|---|
| Design, decisions, what each milestone shipped | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Mesh wire protocol, groups, coordinator API | [`MESH.md`](MESH.md) |
| HTTPS side door (certificates, DNS, port mapping) | [`SIDEDOOR.md`](SIDEDOOR.md) |
| Requests: states, policy, routing and claims | [`REQUESTS.md`](REQUESTS.md) |
| The app: building, the embedded mesh, releases | [`APP-DEV.md`](APP-DEV.md), [`APP-MESH.md`](APP-MESH.md), [`APP-RELEASE.md`](APP-RELEASE.md) |
| UI screen map and API client | [`UI.md`](UI.md) |
| Security review, threat model, residual risks | [`SECURITY.md`](SECURITY.md) |
| Protocol versions and upgrading a group | [`UPGRADING.md`](UPGRADING.md) |
| Every patch to vendored code, and why | [`PATCHES.md`](PATCHES.md) |
| Installing and releasing | [`INSTALL.md`](INSTALL.md), [`RELEASING.md`](RELEASING.md) |

## Licensing

New StingStream code is GPL-3.0-or-later ([`../LICENSE`](../LICENSE)); the mesh binary is
GPL-2.0-or-later. Vendored components keep their own upstream licences; [`../NOTICE.md`](../NOTICE.md)
lists every one of them and every third-party binary a release bundles.
