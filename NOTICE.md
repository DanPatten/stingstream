# NOTICE

StingStream is a monorepo that vendors six upstream open-source projects as git subtrees, plus one
binary fetched on demand (not vendored). New StingStream code is licensed **GPL-3.0-or-later** (see
[`LICENSE`](LICENSE)). Each vendored component keeps its own upstream license, listed below.

## Vendored subtrees

### apps/stingstream — Streamyfin

- **Upstream:** https://github.com/streamyfin/streamyfin
- **Branch vendored:** `develop` — **substituted** for the plan's named branch `master`, which
  does not exist in this repository (`git ls-remote https://github.com/streamyfin/streamyfin
  master` returns nothing). `develop` is the repository's default branch (`HEAD`).
- **Commit vendored:** `a1065eff36f79f7325175777b1985624208d73cd`
- **License:** MPL-2.0 (Mozilla Public License Version 2.0), per `apps/stingstream/LICENSE.txt`.

### server/jellyfin — Jellyfin

- **Upstream:** https://github.com/jellyfin/jellyfin
- **Branch vendored:** `master` (matches both the plan and the repository's default branch/`HEAD`).
- **Commit vendored:** `c80f05fad100433077c3011baeebb52271939823`
- **License:** GPL-2.0, per `server/jellyfin/LICENSE` (the file itself is the plain "Version 2,
  June 1991" text with no "or later" clause). Jellyfin's project lead has stated the project is
  "effectively 2+" (GPL-2.0-or-later in practice) in GitHub issue #8226, but that is a maintainer
  statement, not wording in the LICENSE file itself.

### server/radarr — Radarr

- **Upstream:** https://github.com/Radarr/Radarr
- **Branch vendored:** `develop` (matches both the plan and the repository's default branch/`HEAD`).
- **Commit vendored:** `04e27cb264104973e531cf5226430dabf5611786`
- **License:** GPL-3.0, per `server/radarr/LICENSE` ("Version 3, 29 June 2007" text).

### server/sonarr — Sonarr

- **Upstream:** https://github.com/Sonarr/Sonarr
- **Branch vendored:** `v5-develop` — this is the repository's actual default branch/`HEAD`. M0
  originally vendored `develop` exactly as literally authorized by the plan, but `develop` turned
  out to be Sonarr's older v4 line (pinning .NET 6), not its default branch — `v5-develop` is the
  newer, actively-developed major-version line (pinning .NET 10). Dan decided to re-vendor from
  `v5-develop`; the `develop` subtree was removed and replaced with this one. See `docs/PATCHES.md`.
- **Commit vendored:** `b84a621e991747360b63e074d06fc7d8b534ef63`
- **License:** GPL-3.0, per `server/sonarr/LICENSE.md` ("Version 3, 29 June 2007" text).

### server/infinidysk — nzbdav (InfiniDysk)

- **Upstream:** https://github.com/nzbdav/nzbdav
- **Branch vendored:** `main` (matches both the plan and the repository's default branch/`HEAD`).
- **Commit vendored:** `2043c96906fa3c44f01eb93daec7a83f744b9077`
- **License:** MIT, per `server/infinidysk/LICENSE` ("Copyright (c) 2025 nzbdav-dev").

### mesh/jellyswarrm — Jellyswarrm

- **Role: reference only, not in the request path.** After M0 landed this subtree, the "merge many
  servers" mechanism was redesigned (2026-09-04) around a federated library built inside each
  node's own Jellyfin, replacing the Jellyswarrm reverse-proxy approach. Jellyswarrm remains
  vendored here as a git subtree for reference and as a possible source for its Rust
  `jellyfin-api` client crate only — no StingStream request ever passes through Jellyswarrm code
  today, and no other crate depends on it. See `docs/ARCHITECTURE.md` ("Pivot", "Federated
  library") and `docs/PATCHES.md`. Kept in place per Dan's instruction; M8 will decide whether to
  drop the subtree entirely once (if ever) nothing imports `jellyfin-api` from it.
- **Upstream:** https://github.com/LLukas22/Jellyswarrm
- **Branch:** `main` (matches both the plan and the repository's default branch/`HEAD`).
- **Commit vendored:** `e210972dc76dc53ac7316e8a1f6d80ebee362e04`
- **Vendoring note:** `dev/media/**` (18 files, `.mp4`/`.ogg`, Git-LFS-tracked upstream) is
  committed here as plain LFS pointer text, not the real media — this machine had no `git-lfs`
  installed at vendor time, and there was no reason to require it just to get Jellyswarrm's
  buildable source, which is unaffected. The root `.lfsconfig` excludes this path from ordinary
  LFS fetch so a clone never needs `git-lfs` for this reason; `tools/fetch-jellyswarrm-media.ps1`
  fetches the real content on demand for anyone who wants Jellyswarrm's own dev/demo environment.
  See `docs/PATCHES.md` for full detail, including the CC BY attribution requirement (Big Buck
  Bunny, Sintel) that applies only if that fetch script is actually run.
- **License — exact wording found, quoted verbatim, and Dan's decision:**
  - The top-level `mesh/jellyswarrm/LICENSE` file is the **unfilled** GNU GPL v2 (June 1991)
    boilerplate template as distributed by the FSF — it still contains the literal placeholders
    `{{description}}`, `Copyright (C) {{year}}  {{fullname}}` in its "How to Apply These Terms"
    section, and was never filled in with Jellyswarrm's own project/copyright details.
  - `mesh/jellyswarrm/README.md` carries a badge reading "License-GPL_v2" that links to
    `https://www.gnu.org/licenses/old-licenses/gpl-2.0.html` — the *old-licenses* GPL-2.0-only
    page specifically, not the current/general GPL page. No "or later" wording appears anywhere
    in the README's license badge or link.
  - The three actual Rust crates that make up the buildable project — the ones we are forking —
    each declare their own license directly in `Cargo.toml` and ship real, filled-in
    `LICENSE-MIT` / `LICENSE-APACHE` files (e.g. `crates/jellyswarrm-proxy/LICENSE-MIT` reads
    "Copyright (c) 2025 Lukas Kreussel", a real name, not a template):
    - `crates/jellyswarrm-proxy` (the reverse proxy binary): `license = "MIT OR Apache-2.0"`
    - `crates/jellyswarrm-macros`: `license = "MIT OR Apache-2.0"`
    - `crates/jellyfin-api`: `license = "MIT OR Apache-2.0"`
  - **Dan's decision:** given the top-level LICENSE/README say GPL-2.0 and the crates say
    MIT OR Apache-2.0, StingStream treats Jellyswarrm **conservatively as GPL-2.0** rather than
    relying on the crate-level MIT/Apache-2.0 declaration. StingStream's own mesh crates stay
    **GPL-2.0-or-later**, which is compatible with Jellyswarrm under either reading (a GPL-2.0
    dependency is compatible with a GPL-2.0-or-later work; MIT/Apache-2.0 code is compatible with
    everything). **Recommended follow-up:** ask upstream (LLukas22) to clarify which license
    actually governs the project — file an issue or PR requesting the top-level LICENSE file be
    filled in (or replaced with a note pointing at the per-crate MIT/Apache-2.0 files, if that's
    the intended license) so this ambiguity doesn't need re-litigating on every upstream pull.

## Not vendored (fetched on demand)

### third_party/nzbget — NZBGet (nzbgetcom fork)

- **Upstream:** https://github.com/nzbgetcom/nzbget
- Not a git subtree — prebuilt release binaries only, fetched by
  [`third_party/nzbget/fetch-nzbget.ps1`](third_party/nzbget/fetch-nzbget.ps1) into
  `third_party/nzbget/bin/` (gitignored). Latest release checked during M0: **v26.3**.
- **License:** GPL-2.0 (nzbgetcom is a maintained fork of the original NZBGet, itself GPL-2.0).

## Build-time tooling embedded in release artifacts (M8a)

Neither of these is fetched or vendored into the repository — both are installed on the machine
producing a release (locally via winget, or in `.github/workflows/release.yml`) — but each embeds
a small stub of its own code into the artifact it produces, which is why they are listed here
rather than only in `docs/RELEASING.md`.

- **Inno Setup** (`deploy/windows/StingStream.iss`, compiled by `deploy/windows/build-installer.ps1`):
  the compiled `StingStream-Setup-*.exe` contains Inno Setup's own setup launcher and uninstaller
  stub code. Upstream: https://jrsoftware.org/isinfo.php. License: the
  [Inno Setup License](https://jrsoftware.org/files/is/license.txt), a custom BSD-like license
  requiring only that the license text accompany distribution and that Inno Setup not be
  misrepresented as StingStream's own work — met by this file's own header comment naming it.
- **AppImageKit** (`deploy/linux/appimage/build-appimage.sh`, via `appimagetool`): every
  `StingStream-*.AppImage` this produces embeds AppImageKit's runtime stub (the ELF header code
  that mounts the image's squashfs payload when the file is executed). Upstream:
  https://github.com/AppImage/AppImageKit. License: MIT.

## StingStream's own license

- All new code under `mesh/crates/*`, `server/jellyfin/src/StingStream.Core` (once it exists),
  `packages/api-client`, `tools/`, and `deploy/` is **GPL-3.0-or-later**.
- Per the plan's locked-in licensing outcome: the `stingstream` and `stingstream-relay` binaries
  (which link against Jellyswarrm code) are licensed **GPL-2.0-or-later** specifically, so they
  stay distributable even under a worst-case reading of Jellyswarrm's licensing. Given the finding
  above — that Jellyswarrm's actual crates are MIT/Apache-2.0, not GPL — this conservative choice
  may no longer be necessary; that's Dan's call, not something changed unilaterally here.
- `mesh/crates/stingstream-mesh` is a library with no GPL-licensed dependencies today; its
  `Cargo.toml` currently inherits `license = "GPL-2.0-or-later"` from the workspace for consistency
  with its sibling binaries, pending Dan's decision above.
