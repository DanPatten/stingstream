# deploy/

Everything needed to run a StingStream coordinator or node outside a development checkout:
Dockerfiles, Docker Compose files, and platform installers. Landed across M3 (the coordinator) and
M8a (the node — packaging, installers, and the release pipeline); see `docs/ARCHITECTURE.md` for
how the two milestones divide the work and `docs/RELEASING.md` for how everything here gets built
and published.

| Directory | What it is |
|---|---|
| `coordinator/` | `stingstream-relay`: Dockerfile, Compose (Lite via Railway's one-click template, Full on a VPS, plus the `storage-node` profile), a Railway template. See `coordinator/README.md`. |
| `node/` | The full node image (`ghcr.io/danpatten/stingstream-node`): Dockerfile, Compose, and `LAYOUT.md` — the install tree every delivery mechanism below shares. |
| `windows/` | The Inno Setup installer (`StingStream-Setup-<version>-win-x64.exe`), the Windows service registration scripts, and a winget manifest template. |
| `linux/` | The `.deb` (nfpm config, systemd unit, postinst/postrm scripts) and the AppImage build script. |
| `macos/` | A Homebrew formula **template** — unsigned and unverified; there is no Mac anywhere in this project. See `docs/INSTALL.md` "macOS". |

For a user installing a release rather than building one, start at `docs/INSTALL.md` instead of
here.
