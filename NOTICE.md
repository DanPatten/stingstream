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
- **Branch vendored:** `develop`, exactly as authorized. **Note:** `develop` is *not* this
  repository's default branch/`HEAD` — `git ls-remote --symref` resolves `HEAD` to `v5-develop`
  (a newer, actively-developed major-version line; `git ls-remote ... Sonarr/Sonarr develop`
  resolves to a different, older commit than `v5-develop`'s `HEAD`). `develop` does exist as a
  named branch, so per the M0 rule ("if the branch named above does not exist, use HEAD instead")
  no substitution was made — `develop` was vendored literally as authorized. **This needs Dan's
  decision**: keep `develop`, or re-vendor from `v5-develop`. See the main report for detail.
- **Commit vendored:** `980a6fc09f808a07bee8913f00f408d248b3a269`
- **License:** GPL-3.0, per `server/sonarr/LICENSE.md` ("Version 3, 29 June 2007" text).

### server/infinidysk — nzbdav (InfiniDysk)

- **Upstream:** https://github.com/nzbdav/nzbdav
- **Branch vendored:** `main` (matches both the plan and the repository's default branch/`HEAD`).
- **Commit vendored:** `2043c96906fa3c44f01eb93daec7a83f744b9077`
- **License:** MIT, per `server/infinidysk/LICENSE` ("Copyright (c) 2025 nzbdav-dev").

### mesh/jellyswarrm — Jellyswarrm

- **Upstream:** https://github.com/LLukas22/Jellyswarrm
- **Branch:** `main` (matches both the plan and the repository's default branch/`HEAD`).
- **Commit fetched:** `e210972dc76dc53ac7316e8a1f6d80ebee362e04`
- **Vendoring status: BLOCKED, not yet committed.** `git subtree add` failed partway: the repo
  tracks demo/dev fixture media (`dev/media/**/*.mp4`, `dev/media/**/*.ogg`) via Git LFS per its
  `.gitattributes`, and `git-lfs` is not installed on this machine, so the checkout of those 49
  files failed (`git-lfs smudge` filter error) and the subtree script aborted before creating its
  merge commit. No commit landed and `HEAD` is unaffected, but the working tree/index currently
  hold the rest of the fetched content (174 files — all of the actual source, none of it affected)
  staged outside of any commit. See the main report for the recovery options this needs Dan to
  choose between. All license and source-tree findings below were read directly from that staged
  working-tree content, which is unaffected by the missing dev-fixture media.
- **License — exact wording found, quoted verbatim:**
  - The top-level `mesh/jellyswarrm/LICENSE` file is the **unfilled** GNU GPL v2 (June 1991)
    boilerplate template as distributed by the FSF — it still contains the literal placeholders
    `{{description}}`, `Copyright (C) {{year}}  {{fullname}}` in its "How to Apply These Terms"
    section, and was never filled in with Jellyswarrm's own project/copyright details. Read as
    written, it is GPL-2.0-**only** wording (the template's suggested notice reads "either version
    2 of the License, or (at your option) any later version" — but this is boilerplate *advice to
    adopters* on what to write, not a completed statement that was actually applied).
  - `mesh/jellyswarrm/README.md` carries a badge reading "License-GPL_v2" that links to
    `https://www.gnu.org/licenses/old-licenses/gpl-2.0.html` — the *old-licenses* GPL-2.0-only
    page specifically, not the current/general GPL page. No "or later" wording appears anywhere
    in the README's license badge or link.
  - **However**, the three actual Rust crates that make up the buildable project — the ones we
    are forking — each declare their own license directly in `Cargo.toml` and ship real,
    filled-in `LICENSE-MIT` / `LICENSE-APACHE` files (e.g. `crates/jellyswarrm-proxy/LICENSE-MIT`
    reads "Copyright (c) 2025 Lukas Kreussel", a real name, not a template):
    - `crates/jellyswarrm-proxy` (the reverse proxy binary): `license = "MIT OR Apache-2.0"`
    - `crates/jellyswarrm-macros`: `license = "MIT OR Apache-2.0"`
    - `crates/jellyfin-api`: `license = "MIT OR Apache-2.0"`
  - **Conclusion:** the actual redistributable/buildable Jellyswarrm code (all three of its
    crates) is dual-licensed **MIT OR Apache-2.0** — more permissive than GPL, and not GPL at all.
    The repository's top-level GPL-2.0 LICENSE file/README badge is an unfilled template that
    does not appear to apply to the crate code itself (most likely leftover boilerplate, or
    intended to cover only non-crate assets such as the dev/demo environment and docs). Either
    way, it is GPL-2.0-**only** wording as written, never "or later" — the plan's "GPL-2.0-only
    vs or-later" question is answered as: **neither cleanly applies; the code we're forking is
    actually MIT/Apache-2.0**. Flagged for Dan's decision on whether this changes the mesh
    binary's own license choice below.

## Not vendored (fetched on demand)

### third_party/nzbget — NZBGet (nzbgetcom fork)

- **Upstream:** https://github.com/nzbgetcom/nzbget
- Not a git subtree — prebuilt release binaries only, fetched by
  [`third_party/nzbget/fetch-nzbget.ps1`](third_party/nzbget/fetch-nzbget.ps1) into
  `third_party/nzbget/bin/` (gitignored). Latest release checked during M0: **v26.3**.
- **License:** GPL-2.0 (nzbgetcom is a maintained fork of the original NZBGet, itself GPL-2.0).

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
