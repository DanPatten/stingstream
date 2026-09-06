# StingStream

**One app for your whole media library, and for the people you share it with.**

Most people running their own media library end up with four or five programs that do not know
about each other: something to play files, something to find them, something to download them, and
something to manage all of it from the sofa. StingStream is one install, one interface and one
login for all of it — and then it lets you pool that library with people you invite, so their films
appear in yours as extra sources for the same title, streamed peer-to-peer, encrypted, with nothing
in between.

No accounts with us. No subscription. No cloud. **No server anybody has to host** — a brand new
group works with nothing running anywhere but the members' own computers.

* **Install a node** → [`docs/INSTALL.md`](docs/INSTALL.md) — Windows, macOS, Linux, Docker
* **Understand it** → [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
* **Run one from a checkout** → [`docs/RUNNING.md`](docs/RUNNING.md)
* **Work on it** → [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) (six conventions, each of which
  exists because ignoring it cost somebody a day)

---

## What it does

### Your own library, everywhere

Your media, on your phone, your tablet and your television, from a server you own. Direct play of
the original file wherever the device can manage it, transcoding when it cannot. Watched state,
resume points and favourites live on your own node and go nowhere else.

### Sharing that is actually private

Create a group, send an invite code, and that is the whole of it. Their titles appear in *your*
library — real items, with posters, overviews and quality badges, because they really are extra
versions of the same film — and playback streams directly from their computer to yours.

There is no public directory, no discovery and no way for a stranger to find your node. A group is
people who chose each other. And you can remove one of them at any time: access ends immediately,
the group's key is replaced, and every invite code that existed before it stops working
([`docs/SECURITY.md`](docs/SECURITY.md) §3).

### Grabbing, without four more programs

Radarr and Sonarr run inside the node, configured for you, driven from one interface. A built-in
BitTorrent engine and a bundled NZBGet, or your existing download client if you would rather.
Requests: anyone in the group can ask for something, and whichever node is best placed to fetch it
does — exactly once, without anybody coordinating it.

### The rest of what shipped

| | |
|---|---|
| **Source selection** | Several people hold the same film; the node scores them on connectivity, measured throughput, quality fit and load. Speed-first or quality-first, per person. |
| **Failover** | The node serving you goes away mid-film; another holder of the same bytes takes over by byte offset, in about three seconds. |
| **Offline** | Download to a phone and watch it on a plane. The original file, over the mesh. |
| **Watch together** | Synchronised playback across the group, under 25 ms of drift measured. |
| **Google TV / Android TV** | Full remote control, ten-foot layout, and pairing by approving a code on your phone. |
| **Chromecast** | Over the HTTPS side door, at home and away. |
| **Subtitles** | Fetched once in the languages your group asked for, and shared with the file. |
| **Live TV and DVR** | Recordings federate like anything else. |
| **Pin a title** | Copy a peer's film onto your own disk; the group's index then shows two copies. |

---

## Zero-server by default

A new group needs nothing that anybody hosts. Nodes find each other through public infrastructure —
iroh's relays, its DNS discovery, and the BitTorrent mainline DHT — and an invite code carries the
inviter's address so the first connection works with no lookup at all. Two computers on one LAN can
form a group with the internet unplugged.

**A group may nominate a coordinator**, and there are two reasons to. One: joining works even when
the person who sent the invite has closed their laptop, because members leave an encrypted note at
a rendezvous. Two: it is what the HTTPS side door needs, which is how a browser away from home and
a Chromecast reach your node.

The Group screen has the picker — *Default* (public infrastructure, plus the project's shared
fallback) or *My own server*, taking a hostname. The choice is a property of the group, so it rides
in every invite and every member follows it, and it can be changed later without rebuilding the
group. A coordinator you run is the same binary in Lite mode (one click on Railway) or Full mode (a
VPS); see [`docs/MESH.md`](docs/MESH.md) and [`docs/SIDEDOOR.md`](docs/SIDEDOOR.md).

**A coordinator is never trusted with the group.** Its rendezvous path, its bearer token and its
encryption key are all derived from the group's secret, so it stores opaque blobs at an address it
cannot connect to a group, and it never sees a group id, a member's name, a title, or any content.

---

## The app

One codebase for web, Android phone and Android TV, built on a fork of
[Streamyfin](https://github.com/streamyfin/streamyfin). Every node serves the web build at its own
address; the phone and TV builds are on the
[releases page](https://github.com/DanPatten/stingstream/releases/latest).

The native app embeds its own mesh endpoint, so it dials the node holding the film **directly** —
the bytes do not take a second hop through your own node. See
[`docs/APP-MESH.md`](docs/APP-MESH.md).

iOS is not built. The codebase keeps it buildable in principle and there is no Apple account; see
[`docs/APP-RELEASE.md`](docs/APP-RELEASE.md).

---

## Screenshots

In [`docs/screenshots/`](docs/screenshots/), and used by the store listing in
[`deploy/play/`](deploy/play/).

---

## Repository layout

```
StingStream/
├─ apps/stingstream/         # Expo app  (subtree: streamyfin/streamyfin)  web + phone + TV
├─ server/jellyfin/          # subtree: jellyfin/jellyfin  + src/StingStream.Core (ours)
├─ server/radarr/            # subtree: Radarr/Radarr
├─ server/sonarr/            # subtree: Sonarr/Sonarr  (v5-develop)
├─ server/infinidysk/        # subtree: nzbdav/nzbdav  (optional usenet streaming, not wired up)
├─ mesh/                     # Rust — TWO Cargo workspaces (see docs/ARCHITECTURE.md)
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
└─ docs/                     # the documents linked above
```

## Building it

```powershell
# The node: Rust supervisor + mesh, and the Jellyfin fork that carries StingStream.Core.
cargo build --manifest-path mesh/Cargo.toml
dotnet build server/jellyfin/Jellyfin.Server/Jellyfin.Server.csproj

# The arrs, which we do not patch (see docs/PATCHES.md) -- each pins its own SDK band in its
# own global.json, and the .NET SDK installs side by side.
dotnet build server/radarr/src/Radarr.sln     # SDK 8
dotnet build server/sonarr/src/Sonarr.sln     # SDK 10

# The app. bun only -- yarn's hoisting introduces a second react-native-screens that crashes
# Android at startup, which no bundler check catches. docs/CONTRIBUTING.md rule 5.
cd apps/stingstream && bun install && bun run typecheck && bun test
```

Then `pwsh tools/e2e-m1.ps1` for one node end to end, or any of `e2e-m3` (two nodes and a
federated library), `e2e-m4` (source selection and failover), `e2e-m6` (requests), `e2e-m7` (watch
together), `e2e-m8` (revocation) and `e2e-sidedoor` (ACME and the HTTPS side door). Each one starts
real nodes and asserts against them; none of them mocks the sharing path.

Full instructions, including the private-build-copy dance that lets several people work in one
checkout, are in [`docs/RUNNING.md`](docs/RUNNING.md).

## Security

[`docs/SECURITY.md`](docs/SECURITY.md) has the threat model, what the M8b review found and fixed,
the authorization table for every endpoint, and the residual risks written down rather than rounded
off. [`docs/UPGRADING.md`](docs/UPGRADING.md) has the protocol version policy and what a group does
when its members are on different builds.

## License

New StingStream code is **GPL-3.0-or-later** ([`LICENSE`](LICENSE)); the mesh binary is
GPL-2.0-or-later. Vendored components keep their own upstream licences — [`NOTICE.md`](NOTICE.md)
lists every one of them, and every third-party binary a release bundles.

StingStream provides no content. It is a player and a server for media you already have, and a way
to share it with people you already know.
