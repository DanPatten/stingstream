#!/usr/bin/env bash
# Builds a StingStream AppImage from an already-packaged dist/node/<rid>/ tree
# (tools/package-node.sh) for desktop users who would rather not install a systemd service.
#
# Usage:
#   deploy/linux/appimage/build-appimage.sh --rid linux-x64 --version 0.8.0
#
# Downloads appimagetool for the matching architecture into a scratch directory if not already on
# PATH. Output: dist/installers/StingStream-<version>-<arch>.AppImage
set -euo pipefail

RID=""
VERSION=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --rid) RID="$2"; shift 2 ;;
        --version) VERSION="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done
[[ -n "$RID" && -n "$VERSION" ]] || {
    echo "usage: $0 --rid <linux-x64|linux-arm64> --version X.Y.Z" >&2
    exit 1
}

case "$RID" in
    linux-x64)   APPIMAGE_ARCH=x86_64; TOOL_ARCH=x86_64 ;;
    linux-arm64) APPIMAGE_ARCH=aarch64; TOOL_ARCH=aarch64 ;;
    *) echo "AppImage only makes sense for linux-x64 or linux-arm64, not $RID" >&2; exit 1 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_DIR="$REPO_ROOT/dist/node/$RID"
[[ -d "$NODE_DIR" ]] || { echo "No $NODE_DIR -- run tools/package-node.sh --rid $RID first." >&2; exit 1; }

OUT_DIR="$REPO_ROOT/dist/installers"
WORK_DIR="$REPO_ROOT/dist/appimage-work/$RID"
APPDIR="$WORK_DIR/StingStream.AppDir"
mkdir -p "$OUT_DIR"
rm -rf "$APPDIR"
mkdir -p "$APPDIR"

echo "== Assembling $APPDIR =="
cp -r "$NODE_DIR/bin" "$APPDIR/bin"
[[ -d "$NODE_DIR/web" ]] && cp -r "$NODE_DIR/web" "$APPDIR/web"
cp "$NODE_DIR/LICENSE" "$APPDIR/"
cp "$NODE_DIR/NOTICE.md" "$APPDIR/"
[[ -f "$NODE_DIR/VERSION" ]] && cp "$NODE_DIR/VERSION" "$APPDIR/"

cp "$REPO_ROOT/deploy/linux/appimage/AppRun" "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"
cp "$REPO_ROOT/deploy/linux/appimage/stingstream.desktop" "$APPDIR/stingstream.desktop"

# The app's own 1024x1024 icon (apps/stingstream/assets/images/icon.png) -- referenced, not
# duplicated into deploy/, so it stays whoever's source of truth apps/stingstream already is.
ICON_SRC="$REPO_ROOT/apps/stingstream/assets/images/icon.png"
if [[ -f "$ICON_SRC" ]]; then
    cp "$ICON_SRC" "$APPDIR/stingstream.png"
    cp "$ICON_SRC" "$APPDIR/.DirIcon"
else
    echo "WARNING: no icon at $ICON_SRC -- the AppImage will have no icon." >&2
fi

APPIMAGETOOL="$WORK_DIR/appimagetool-$TOOL_ARCH.AppImage"
if ! command -v appimagetool > /dev/null 2>&1 && [[ ! -x "$APPIMAGETOOL" ]]; then
    echo "== Fetching appimagetool ($TOOL_ARCH) =="
    curl -fsSL -o "$APPIMAGETOOL" \
        "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-$TOOL_ARCH.AppImage"
    chmod +x "$APPIMAGETOOL"
fi
TOOL=$(command -v appimagetool || echo "$APPIMAGETOOL")

echo "== Building the AppImage =="
OUT_FILE="$OUT_DIR/StingStream-$VERSION-$APPIMAGE_ARCH.AppImage"
# --appimage-extract-and-run: appimagetool is itself an AppImage, and a CI container frequently has
# no FUSE available to mount it directly.
ARCH="$APPIMAGE_ARCH" "$TOOL" --appimage-extract-and-run "$APPDIR" "$OUT_FILE"

echo "== Done: $OUT_FILE =="
ls -lh "$OUT_FILE"
