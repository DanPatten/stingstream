#!/usr/bin/env bash
# Builds and assembles a StingStream node install tree for one RID into dist/node/<rid>/.
#
# See deploy/node/LAYOUT.md for the tree this produces and why each file lives where it does, and
# tools/package-node.ps1's own header comment for the full rationale (self-contained but NOT
# trimmed, why Radarr and Sonarr publish differently, why this is safe to run alongside somebody
# else's debug build in the same checkout). This is that script's Linux/macOS twin, used by CI
# (ubuntu-latest, for linux-x64 and linux-arm64) and for producing the unsigned macOS tarball
# layout that docs/INSTALL.md documents as unverified (no Mac available anywhere in this project).
#
# Usage:
#   tools/package-node.sh --rid linux-x64
#   tools/package-node.sh --rid linux-x64 --skip-build      # assemble only
#   tools/package-node.sh --rid osx-arm64 --skip-fetch      # no nzbget/ffmpeg fetch on this host
#
set -euo pipefail

RID=""
SKIP_BUILD=0
SKIP_WEB=0
SKIP_FETCH=0
OUT_DIR=""
VERSION=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rid) RID="$2"; shift 2 ;;
        --skip-build) SKIP_BUILD=1; shift ;;
        --skip-web) SKIP_WEB=1; shift ;;
        --skip-fetch) SKIP_FETCH=1; shift ;;
        --out-dir) OUT_DIR="$2"; shift 2 ;;
        --version) VERSION="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$RID" ]]; then
    echo "usage: $0 --rid <win-x64|linux-x64|linux-arm64|osx-x64|osx-arm64> [--skip-build] [--skip-web] [--skip-fetch] [--out-dir DIR] [--version X.Y.Z]" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${OUT_DIR:=$REPO_ROOT/dist/node/$RID}"
if [[ -z "$VERSION" ]]; then
    VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' "$REPO_ROOT/mesh/crates/stingstream/Cargo.toml" | head -1)
    : "${VERSION:=0.0.0}"
fi

echo "== StingStream node package: $RID (version $VERSION) =="
echo "Repo root: $REPO_ROOT"
echo "Output:    $OUT_DIR"
[[ -n "${CARGO_HOME:-}" ]] && echo "CARGO_HOME:     $CARGO_HOME"
[[ -n "${NUGET_PACKAGES:-}" ]] && echo "NUGET_PACKAGES: $NUGET_PACKAGES"

# --- RID mapping --------------------------------------------------------------------------
# See package-node.ps1's own table / deploy/node/LAYOUT.md for why nzbget has no linux-arm64
# entry: nzbgetcom does not publish an arm64 Linux release asset.
case "$RID" in
    win-x64)     RUST_TRIPLE=x86_64-pc-windows-msvc;    FFMPEG_PLATFORM=win64;      NZBGET_PLATFORM=win64;     BUILD_PLATFORM=Windows; EXE=.exe ;;
    linux-x64)   RUST_TRIPLE=x86_64-unknown-linux-gnu;  FFMPEG_PLATFORM=linux64;    NZBGET_PLATFORM=linux-x64; BUILD_PLATFORM=Posix;   EXE= ;;
    linux-arm64) RUST_TRIPLE=aarch64-unknown-linux-gnu; FFMPEG_PLATFORM=linuxarm64; NZBGET_PLATFORM=;          BUILD_PLATFORM=Posix;   EXE= ;;
    osx-x64)     RUST_TRIPLE=x86_64-apple-darwin;       FFMPEG_PLATFORM=macos;      NZBGET_PLATFORM=macos;     BUILD_PLATFORM=Posix;   EXE= ;;
    osx-arm64)   RUST_TRIPLE=aarch64-apple-darwin;      FFMPEG_PLATFORM=macos;      NZBGET_PLATFORM=macos;     BUILD_PLATFORM=Posix;   EXE= ;;
    *) echo "Unknown RID: $RID" >&2; exit 1 ;;
esac

# Whether cargo builds this triple natively (no --target needed) on the current host.
HOST_TRIPLE=$(rustc -vV | sed -n 's/host: //p')
if [[ "$RUST_TRIPLE" == "$HOST_TRIPLE" ]]; then
    RUST_TARGET_DIR="$REPO_ROOT/mesh/target/release"
    RUST_NATIVE=1
else
    RUST_TARGET_DIR="$REPO_ROOT/mesh/target/$RUST_TRIPLE/release"
    RUST_NATIVE=0
fi
SUPERVISOR_BIN="$RUST_TARGET_DIR/stingstream$EXE"
MESH_BIN="$RUST_TARGET_DIR/stingstream-mesh$EXE"

# --- 1. Rust: supervisor + mesh -------------------------------------------------------------

if [[ "$SKIP_BUILD" -eq 0 ]]; then
    echo "-- cargo build --release ($RUST_TRIPLE$([[ $RUST_NATIVE -eq 1 ]] && echo ' (native)'))"
    CARGO_ARGS=(build --release --manifest-path "$REPO_ROOT/mesh/Cargo.toml" -p stingstream -p stingstream-mesh)
    [[ "$RUST_NATIVE" -eq 0 ]] && CARGO_ARGS+=(--target "$RUST_TRIPLE")
    cargo "${CARGO_ARGS[@]}"
fi
[[ -f "$SUPERVISOR_BIN" ]] || { echo "Expected the supervisor at $SUPERVISOR_BIN -- build it first, or drop --skip-build." >&2; exit 1; }
[[ -f "$MESH_BIN" ]] || echo "WARNING: no stingstream-mesh binary at $MESH_BIN -- bin/mesh/ will be empty (only matters for [mesh] embedded = false)." >&2

# --- 2. .NET: Jellyfin, Radarr, Sonarr -------------------------------------------------------
# See tools/package-node.ps1's header and docs/RELEASING.md "Known packaging quirks" for why
# Radarr publishes through its own -t:PublishAllRids MSBuild target while Jellyfin and Sonarr go
# through a plain `dotnet publish` of a single project.

publish_dotnet() {
    local name="$1" proj_or_sln="$2" framework="$3" out_subdir="$4" publish_all_rids_target="${5:-}"
    [[ "$SKIP_BUILD" -eq 1 ]] && return 0
    echo "-- dotnet publish: $name ($RID, $framework)"
    if [[ -n "$publish_all_rids_target" ]]; then
        dotnet msbuild -restore "$proj_or_sln" \
            -p:SelfContained=True -p:Configuration=Release -p:Platform="$BUILD_PLATFORM" \
            -p:RuntimeIdentifiers="$RID" -t:"$publish_all_rids_target"
    else
        dotnet publish "$proj_or_sln" -c Release -r "$RID" -f "$framework" \
            --self-contained true -p:UseAppHost=true -p:RunAnalyzersDuringBuild=false \
            -o "$REPO_ROOT/$out_subdir"
    fi
}

publish_dotnet Jellyfin "$REPO_ROOT/server/jellyfin/Jellyfin.Server/Jellyfin.Server.csproj" net10.0 "dist/publish/jellyfin/$RID"
JELLYFIN_OUT="$REPO_ROOT/dist/publish/jellyfin/$RID"

publish_dotnet Radarr "$REPO_ROOT/server/radarr/src/Radarr.sln" net8.0 "" PublishAllRids
RADARR_OUT="$REPO_ROOT/server/radarr/_output/net8.0/$RID/publish"

publish_dotnet Sonarr "$REPO_ROOT/server/sonarr/src/NzbDrone.Console/Sonarr.Console.csproj" net10.0 "dist/publish/sonarr/$RID"
SONARR_OUT="$REPO_ROOT/dist/publish/sonarr/$RID"

# Sonarr.Console does not reference its platform assembly as a project dependency -- it is loaded
# by NAME at runtime (NzbDrone.Common.Composition.AssemblyLoader: `OsInfo.IsWindows ?
# "Sonarr.Windows" : "Sonarr.Mono"`, resolved from the executable's own directory). A plain
# `dotnet publish` of just NzbDrone.Console therefore produces a tree that starts and immediately
# throws `FileNotFoundException: ... Sonarr.Windows.dll` -- found running package-node.ps1's own
# output for real on win-x64 (docs/RELEASING.md "Known packaging quirks"); the same gap applies to
# every RID here, just with Sonarr.Mono.dll instead. Radarr does not have this problem because it
# publishes through `-t:PublishAllRids` against the whole solution, which builds every platform
# project regardless; doing that for Sonarr hits a NU1510/CS1591-as-error wall (see this script's
# own header comment), so instead this builds just the one extra small library project.
if [[ "$SKIP_BUILD" -eq 0 ]]; then
    if [[ "$RID" == "win-x64" ]]; then
        sonarr_platform_proj="server/sonarr/src/NzbDrone.Windows/Sonarr.Windows.csproj"
        sonarr_platform_dll="Sonarr.Windows.dll"
    else
        sonarr_platform_proj="server/sonarr/src/NzbDrone.Mono/Sonarr.Mono.csproj"
        sonarr_platform_dll="Sonarr.Mono.dll"
    fi
    echo "-- dotnet build: Sonarr's platform assembly ($sonarr_platform_dll)"
    tmp_out="$REPO_ROOT/dist/publish/sonarr-platform-tmp/$RID"
    dotnet build "$REPO_ROOT/$sonarr_platform_proj" -c Release -f net10.0 -r "$RID" \
        --self-contained false -p:RunAnalyzersDuringBuild=false -o "$tmp_out"
    cp "$tmp_out/$sonarr_platform_dll" "$SONARR_OUT/"
fi

for pair in "Jellyfin:$JELLYFIN_OUT:jellyfin" "Radarr:$RADARR_OUT:Radarr.Console Radarr" "Sonarr:$SONARR_OUT:Sonarr.Console Sonarr"; do
    name="${pair%%:*}"; rest="${pair#*:}"; dir="${rest%%:*}"; stems="${rest#*:}"
    [[ -d "$dir" ]] || { echo "$name: expected publish output at $dir -- build it first, or drop --skip-build." >&2; exit 1; }
    found=0
    for stem in $stems; do [[ -f "$dir/$stem$EXE" ]] && found=1; done
    [[ "$found" -eq 1 ]] || { echo "$name: no {$stems}$EXE found in $dir" >&2; exit 1; }
done

# Sonarr's platform assembly specifically -- a missing one is a silent-at-build-time,
# crash-at-runtime failure the loop above (which only checks for the .exe) would not catch.
if [[ "$RID" == "win-x64" ]]; then sonarr_platform_dll="Sonarr.Windows.dll"; else sonarr_platform_dll="Sonarr.Mono.dll"; fi
[[ -f "$SONARR_OUT/$sonarr_platform_dll" ]] || {
    echo "Sonarr: no $sonarr_platform_dll in $SONARR_OUT -- Sonarr will crash on startup with a FileNotFoundException. Build it first, or drop --skip-build." >&2
    exit 1
}

# --- 3. third_party: jellyfin-ffmpeg, nzbget --------------------------------------------------

FFMPEG_SRC="$REPO_ROOT/third_party/ffmpeg/bin/$FFMPEG_PLATFORM"
if [[ "$SKIP_FETCH" -eq 0 ]] && ! compgen -G "$FFMPEG_SRC/ffmpeg*" > /dev/null; then
    echo "-- fetching jellyfin-ffmpeg for $FFMPEG_PLATFORM"
    pwsh "$REPO_ROOT/third_party/ffmpeg/fetch-jellyfin-ffmpeg.ps1" -Platform "$FFMPEG_PLATFORM"
fi

NZBGET_SRC=""
if [[ -n "$NZBGET_PLATFORM" ]]; then
    NZBGET_SRC="$REPO_ROOT/third_party/nzbget/bin/$NZBGET_PLATFORM"
    if [[ "$SKIP_FETCH" -eq 0 ]] && ! compgen -G "$NZBGET_SRC/nzbget*" > /dev/null; then
        echo "-- fetching nzbget for $NZBGET_PLATFORM"
        pwsh "$REPO_ROOT/third_party/nzbget/fetch-nzbget.ps1" -Platform "$NZBGET_PLATFORM"
    fi
else
    echo "WARNING: no nzbget release for $RID (nzbgetcom publishes no arm64 Linux asset -- see deploy/node/LAYOUT.md). bin/nzbget/ will be empty; the node still comes up with NZBGet reported as disabled." >&2
fi

# --- 4. web bundle ----------------------------------------------------------------------------

WEB_DIST="$REPO_ROOT/apps/stingstream/dist"
if [[ "$SKIP_WEB" -eq 0 ]] && [[ ! -f "$WEB_DIST/index.html" ]]; then
    echo "-- building the web bundle (bun install + bun run build:web)"
    (cd "$REPO_ROOT/apps/stingstream" && bun install && bun run build:web)
fi

# --- 5. assemble the tree ----------------------------------------------------------------------

echo "-- assembling $OUT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"/bin/{jellyfin,radarr,sonarr,mesh,ffmpeg,nzbget}

cp "$SUPERVISOR_BIN" "$OUT_DIR/bin/stingstream$EXE"
[[ -f "$MESH_BIN" ]] && cp "$MESH_BIN" "$OUT_DIR/bin/mesh/stingstream-mesh$EXE"

cp -r "$JELLYFIN_OUT"/. "$OUT_DIR/bin/jellyfin/"
cp -r "$RADARR_OUT"/. "$OUT_DIR/bin/radarr/"
cp -r "$SONARR_OUT"/. "$OUT_DIR/bin/sonarr/"

if [[ -d "$FFMPEG_SRC" ]]; then
    find "$FFMPEG_SRC" -mindepth 1 -maxdepth 1 ! -name '*.zip' ! -name '*.tar.xz' ! -name '*.tar.gz' \
        -exec cp -r {} "$OUT_DIR/bin/ffmpeg/" \;
fi
if [[ -n "$NZBGET_SRC" && -d "$NZBGET_SRC" ]]; then
    find "$NZBGET_SRC" -mindepth 1 -maxdepth 1 ! -name '*-setup.exe' ! -name '*.run' ! -name 'Uninstall.exe' \
        -exec cp -r {} "$OUT_DIR/bin/nzbget/" \;
fi

if [[ -f "$WEB_DIST/index.html" ]]; then
    cp -r "$WEB_DIST" "$OUT_DIR/web"
else
    echo "WARNING: no web bundle at $WEB_DIST -- the packaged node will serve its placeholder page." >&2
fi

cp "$REPO_ROOT/LICENSE" "$OUT_DIR/"
cp "$REPO_ROOT/NOTICE.md" "$OUT_DIR/"
printf '%s' "$VERSION" > "$OUT_DIR/VERSION"

echo ""
echo "== Done: $OUT_DIR =="
du -sh "$OUT_DIR" 2>/dev/null || true
echo "Run it: $OUT_DIR/bin/stingstream$EXE --install-root $OUT_DIR --data-dir <somewhere> [--port 8790]"
