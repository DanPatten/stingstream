# Patches and deviations from upstream

StingStream's rule is config-over-patch: prefer supervisor-driven configuration over touching
vendored source, and when a patch is unavoidable, list it here so upstream pulls
(`tools/upstream-pull.ps1`) can be reviewed against this list. This file starts during M0 with
build/vendoring-level deviations (no application source has been patched yet — M1 is where
`StingStream.Core` and any unavoidable Radarr/Sonarr code patches will start landing).

## apps/stingstream (Streamyfin)

- **Vendored from `develop`, not `master`.** The plan named `master`; it does not exist in
  `streamyfin/streamyfin` at all (`git ls-remote https://github.com/streamyfin/streamyfin master`
  returns nothing). `develop` is the repository's actual default branch (`HEAD`) and was used
  instead, per the M0 branch-substitution rule. No content patch — this is a vendoring-source
  choice, recorded here and in `NOTICE.md`/`tools/upstream-pull.ps1`.

## server/sonarr (Sonarr)

- **Re-vendored from `develop` (v4, .NET 6) to `v5-develop` (v5, .NET 10).** M0 first vendored the
  plan's literally-named branch, `develop` — which does exist, but is Sonarr's older v4 line, not
  its actual default branch/`HEAD`. Dan decided to re-vendor from `v5-develop` (the actively
  developed, default branch) instead. The `develop` subtree was removed
  (`git rm -r server/sonarr`) and re-added from `v5-develop` in a follow-up M0 pass. No content
  patch — a vendoring-source correction, recorded here, in `NOTICE.md`, and in
  `tools/upstream-pull.ps1`.

## mesh/jellyswarrm (Jellyswarrm)

- **Reference only — not in the request path.** M0 vendored this subtree when the plan called for
  forking Jellyswarrm as a reverse proxy. On 2026-09-04, after M0's build/vendoring work landed,
  the merge mechanism was redesigned around a federated library built inside each node's own
  Jellyfin (`.strm`/`.nfo` materialization from the group index), which replaces the Jellyswarrm
  proxy entirely. This subtree stays vendored — kept in place per Dan's instruction, not
  removed — as reference and as a possible source for its Rust `jellyfin-api` client crate only.
  No StingStream code calls into Jellyswarrm today and no other crate depends on it. See
  `docs/ARCHITECTURE.md` ("Pivot", "Federated library") for the design and `NOTICE.md` for the
  license finding. M8 will decide whether to drop the subtree entirely once (if ever) nothing
  imports `jellyfin-api` from it.
- **Dev/demo fixture media kept as Git LFS pointer files, not fetched.**
  `mesh/jellyswarrm/dev/media/**` (18 files, `.mp4`/`.ogg`, per Jellyswarrm's own `.gitattributes`)
  is committed here as plain LFS pointer text, exactly as `git subtree add` would normally produce
  when Git LFS smudge/clean/process filters are unavailable. This repo's `.lfsconfig` explicitly
  excludes that path from ordinary LFS fetch/pull
  (`lfs.fetchexclude = mesh/jellyswarrm/dev/media/**`), so a clone never needs `git-lfs` installed
  just to get the real (buildable, non-media) source. `tools/fetch-jellyswarrm-media.ps1` fetches
  the real media on demand into the working tree (never touching this repo's git history) for
  anyone who actually wants to run Jellyswarrm's own dev/demo environment.
  - **Attribution note:** two of those fixtures — Big Buck Bunny (2008) and Sintel (2010) — are
    CC BY 3.0 and require attribution if used or shown beyond local development. See
    `mesh/jellyswarrm/dev/MEDIA-LICENSES.md`. This only matters if
    `tools/fetch-jellyswarrm-media.ps1` is actually run; the pointer files committed here carry no
    such obligation on their own.
- **`ui` git submodule pinned to `update = none` in the root `.gitmodules`.**
  `crates/jellyswarrm-proxy` embeds Jellyswarrm's own admin UI from a `ui/` git submodule
  (`jellyfin/jellyfin-web.git`). `git subtree add`/`pull` never initializes submodules, so `ui/`
  is a gitlink with no working-tree content after vendoring. The root `.gitmodules` entry with
  `update = none` means an ordinary `git submodule update --init --recursive` run anywhere in this
  repo skips it cleanly instead of failing on a path that isn't really "our" submodule to manage.
  We do not need Jellyswarrm's bundled admin UI — StingStream's own UI is `apps/stingstream`
  (Streamyfin) — so this submodule is intentionally never initialized.
- **Build accommodations for `crates/jellyswarrm-proxy` (not source patches):**
  - `JELLYSWARRM_SKIP_UI=1` environment variable (an escape hatch Jellyswarrm's own `build.rs`
    already provides) skips the npm/yarn build of the `ui/` submodule content that isn't present.
  - An **empty `static/` directory** must exist at `crates/jellyswarrm-proxy/static/` for
    `#[derive(RustEmbed)] #[folder = "static/"] struct Asset;` in `src/main.rs` to compile — if the
    folder is missing, the derive macro still compiles `Asset` but never implements the `Embed`
    trait, so any call to `Asset::get(...)` fails with "associated item not found." This directory
    is not committed (git doesn't track empty directories, and it's not part of the vendored
    source) — anyone building this crate with `JELLYSWARRM_SKIP_UI=1` needs to create it locally;
    CI does this as an explicit step (see `.github/workflows/ci.yml`).

## Not a patch, but recorded here for visibility

- **`mesh/` is two separate Cargo workspaces**, not one (`mesh/Cargo.toml` for the three new
  `stingstream*` crates, `mesh/jellyswarrm/Cargo.toml` for Jellyswarrm, untouched). See
  `docs/ARCHITECTURE.md` "Mesh workspace" for why unifying them was tried and doesn't work
  (Jellyswarrm's crates need their own full `workspace.dependencies` table, ~40 entries, inherited
  via `field.workspace = true`). This is a repository-layout decision, not a code change to either
  side.
