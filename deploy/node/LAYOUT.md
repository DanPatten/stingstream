# The node install layout

What `tools/package-node.ps1` / `tools/package-node.sh` produce into `dist/node/<rid>/`, what the
Windows installer copies to `%ProgramFiles%\StingStream`, what the `.deb` copies to
`/opt/stingstream`, and what `deploy/node/Dockerfile` bakes into the node image. One layout, four
delivery mechanisms.

```
<install>/
├─ bin/
│  ├─ stingstream(.exe)          the supervisor + gateway (mesh/crates/stingstream, release build)
│  ├─ mesh/
│  │  └─ stingstream-mesh(.exe)  the mesh as a standalone child -- see "Why mesh/ has its own
│  │                             directory" below. Not started unless [mesh] embedded = false.
│  ├─ jellyfin/                  self-contained `dotnet publish` of Jellyfin.Server (+ StingStream.Core)
│  ├─ radarr/                    self-contained publish of NzbDrone.Console (Radarr.Console)
│  ├─ sonarr/                    self-contained publish of NzbDrone.Console (Sonarr.Console)
│  ├─ nzbget/                    the fetched nzbgetcom binary and its webui/, unpacked
│  └─ ffmpeg/                    the fetched jellyfin-ffmpeg binaries (ffmpeg, ffprobe)
├─ web/                          `bun run build:web`'s output (apps/stingstream/dist), served at /
├─ LICENSE                       StingStream's own (GPL-3.0-or-later)
├─ NOTICE.md                     third-party licenses -- copied from the repo root
└─ VERSION                       plain text, one line, e.g. `0.1.1` (read by the update check)
```

Everything a *running* node writes — `config.toml`, `runtime.json`, logs, the arrs' own data, media
— lives outside this tree entirely, under `$STINGSTREAM_DATA` (`docs/RUNNING.md`). `<install>` is
read-only from the node's own point of view after packaging: an upgrade replaces it wholesale and
the data directory survives untouched.

## Why this shape, and where it comes from

Every one of these paths is load-bearing in
[`mesh/crates/stingstream/src/supervisor/childdef.rs`](../../mesh/crates/stingstream/src/supervisor/childdef.rs)
— this file exists because that one doesn't have a "for humans" view of its own search paths:

| Path | Resolved by | Search depth |
|---|---|---|
| `bin/jellyfin/` | `resolve_prod_dotnet(install_root, "jellyfin")` | exact: `bin/jellyfin/{jellyfin.exe\|jellyfin.dll}` |
| `bin/radarr/` | `resolve_prod_dotnet(install_root, "radarr")` | exact: `bin/radarr/{Radarr.Console\|Radarr}{.exe,.dll}` |
| `bin/sonarr/` | `resolve_prod_dotnet(install_root, "sonarr")` | exact: `bin/sonarr/{Sonarr.Console\|Sonarr}{.exe,.dll}` |
| `bin/nzbget/` | `find_nzbget(_, install_root)` | shallow search, depth 3 (nzbget's own installer nests it) |
| `bin/ffmpeg/` | `find_ffmpeg(_, install_root)` | shallow search, depth 3 (jellyfin-ffmpeg ships `ffmpeg`/`ffprobe` at the top of its archive, but the search tolerates a nested layout too) |
| `bin/mesh/stingstream-mesh(.exe)` | `find_mesh_binary(_, install_root)` | exact: `bin/mesh/stingstream-mesh{.exe,}` |
| `web/` | `resolve_web_dist` (the default when neither `--web-dist` nor `gateway.web_dist` is set) | exact |

**`bin/stingstream(.exe)` is the one path this document deliberately does *not* match the
binary's own fallback for.** When `stingstream` is launched with no `--install-root`, it derives one
by walking up three parent directories from its own executable path (`resolve_mode` in `main.rs`):
`<install>/bin/stingstream/stingstream(.exe) -> <install>`, i.e. it expects to find *itself* one
directory deeper than every other child. That fallback exists so a developer's own ad-hoc copy
still finds its data without arguments; it is not something any packaging output here relies on.
Every launcher this milestone writes — the Windows service's `binPath`, the systemd unit's
`ExecStart`, `deploy/node/Dockerfile`'s `ENTRYPOINT` — passes `--install-root <install>` explicitly,
so `stingstream(.exe)` sits flat in `bin/` next to its children rather than in a `bin/stingstream/`
subdirectory of its own. A user who copies the tree somewhere and double-clicks
`bin\stingstream.exe` directly (no service, no shortcut) needs to pass `--install-root` too; the
Start Menu shortcut points at `http://localhost:8790`, not at the executable, for exactly this
reason — nobody is meant to launch the binary that way.

**Why `mesh/` has its own subdirectory when nothing else child-shaped does.** The mesh runs
*embedded* in the supervisor's own process by default (`[mesh] embedded = true`, `docs/RUNNING.md`)
and `stingstream-mesh(.exe)` is not started at all in that mode — it exists in the tree only so
`[mesh] embedded = false` (attaching a debugger to just the mesh, or a packaging split nobody needs
yet) has something to find. `find_mesh_binary` hard-codes the `bin/mesh/` subdirectory regardless,
so it stays there rather than flattened alongside `stingstream(.exe)` for consistency with the other
children's own subdirectories.

## Per-RID content

`tools/package-node.ps1 -Rid win-x64` / `tools/package-node.sh --rid linux-x64` (etc.) produce one
`dist/node/<rid>/` tree per target. RIDs follow .NET's own naming, which the Rust build's own target
triples and the fetch scripts' platform tokens are each mapped to:

| RID | Rust target triple | jellyfin-ffmpeg platform | nzbget platform | Built/verified where |
|---|---|---|---|---|
| `win-x64` | `x86_64-pc-windows-msvc` | `win64` | `win64` | Locally (Dan's machine) + not in CI |
| `linux-x64` | `x86_64-unknown-linux-gnu` | `linux64` | `linux-x64` | CI (ubuntu-latest) |
| `linux-arm64` | `aarch64-unknown-linux-gnu` | `linuxarm64` | *(none published upstream — see below)* | CI, best-effort |
| `osx-x64` | `x86_64-apple-darwin` | `macos` | `macos` | Tree produced, unsigned, **unverified** (no Mac available) |
| `osx-arm64` | `aarch64-apple-darwin` | `macos` | `macos` | Tree produced, unsigned, **unverified** (no Mac available) |

**`linux-arm64` has no nzbget binary.** `third_party/nzbget/fetch-nzbget.ps1`'s `$PlatformPatterns`
only knows `win64`, `linux-x64` and `macos` — nzbgetcom does not publish an arm64 release asset as of
this writing. `package-node.sh --rid linux-arm64` produces a tree with `bin/nzbget/` absent and a
warning; the supervisor's own `find_nzbget` already treats a missing binary as "not started" rather
than a hard failure (`build_children` in `supervisor/mod.rs`), so the node still comes up with
Jellyfin, Radarr and Sonarr and NZBGet reporting `Disabled`. Fixing this needs either an upstream
release or building nzbget from source for arm64, neither of which is in scope here.

Cross-RID note: everything here can be *produced* from a single Windows host — `dotnet publish -r
<rid>` cross-compiles .NET output for any RID, and `cargo build --target <triple>` cross-compiles
Rust wherever the target's toolchain component and (for a non-Windows target) a suitable linker are
installed. Only `win-x64` is *run* locally, because this machine cannot execute Linux or macOS
binaries to prove they start; the Linux trees are exercised by CI instead (see
`docs/RELEASING.md`), and the macOS trees are not run anywhere (see `docs/INSTALL.md`).
