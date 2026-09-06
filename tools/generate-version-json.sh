#!/usr/bin/env bash
# Generates version.json for a StingStream release.
#
# This is what the node's own update check (mesh/crates/stingstream/src/updatecheck.rs) polls
# daily, and what docs/RELEASING.md documents as the source of truth for "what is the latest
# release, and where do I get it for my platform". Published as a release asset by
# .github/workflows/release.yml, at a stable URL GitHub provides for free for whichever release is
# marked "latest":
#
#   https://github.com/<repo>/releases/latest/download/version.json
#
# Usage:
#   tools/generate-version-json.sh --version 0.1.0 --repo DanPatten/stingstream \
#       --artifacts-dir dist/final --out dist/final/version.json
#
# Expects dist/final/ to already hold the release's actual artifact files, named exactly as the
# other packaging steps in this milestone produce them, and a SHA256SUMS file computed alongside
# them (sha256sum * > SHA256SUMS, run from inside dist/final). A platform whose artifact is not
# present (e.g. a macOS leg that failed, or Android skipped this release) is simply omitted from
# "platforms" rather than failing the whole script -- a release missing one platform is still a
# release.
set -euo pipefail

VERSION="" REPO="" ARTIFACTS_DIR="" OUT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --repo) REPO="$2"; shift 2 ;;
        --artifacts-dir) ARTIFACTS_DIR="$2"; shift 2 ;;
        --out) OUT="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done
if [[ -z "$VERSION" || -z "$REPO" || -z "$ARTIFACTS_DIR" || -z "$OUT" ]]; then
    echo "usage: $0 --version X.Y.Z --repo owner/name --artifacts-dir DIR --out FILE" >&2
    exit 1
fi

SUMS="$ARTIFACTS_DIR/SHA256SUMS"
[[ -f "$SUMS" ]] || { echo "No $SUMS -- compute checksums (sha256sum * > SHA256SUMS in $ARTIFACTS_DIR) before generating version.json." >&2; exit 1; }

sha_for() {
    # SHA256SUMS lines look like "<hash>  <filename>" or "<hash> *<filename>" -- awk's default
    # field splitting on whitespace collapses the doubled separator either way, so $2 is always
    # the filename (with sha256sum's optional leading "*" for binary mode stripped by the tr).
    awk -v f="$1" '{ name=$2; sub(/^\*/, "", name); if (name == f) print $1 }' "$SUMS"
}

entries=()
add() {
    local key="$1" file="$2"
    if [[ -f "$ARTIFACTS_DIR/$file" ]]; then
        local sha
        sha=$(sha_for "$file")
        if [[ -z "$sha" ]]; then
            echo "WARNING: $file exists but has no entry in $SUMS -- omitting from version.json" >&2
            return
        fi
        entries+=("\"$key\": {\"url\": \"https://github.com/$REPO/releases/download/v$VERSION/$file\", \"sha256\": \"$sha\"}")
    fi
}

add windows-x64          "StingStream-Setup-$VERSION-win-x64.exe"
add linux-x64-deb        "stingstream_${VERSION}_amd64.deb"
add linux-arm64-deb      "stingstream_${VERSION}_arm64.deb"
add linux-x64-appimage   "StingStream-$VERSION-x86_64.AppImage"
add linux-arm64-appimage "StingStream-$VERSION-aarch64.AppImage"
add macos-x64-tarball    "StingStream-$VERSION-osx-x64.tar.gz"
add macos-arm64-tarball  "StingStream-$VERSION-osx-arm64.tar.gz"
add android-phone-apk    "stingstream-phone-$VERSION-unsigned.apk"
add android-tv-apk       "stingstream-tv-$VERSION-unsigned.apk"

platforms_json=""
for e in "${entries[@]:-}"; do
    [[ -z "$e" ]] && continue
    if [[ -n "$platforms_json" ]]; then platforms_json+=", "; fi
    platforms_json+="$e"
done

cat > "$OUT" <<EOF
{
  "version": "$VERSION",
  "released_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": { $platforms_json },
  "docker": {
    "image": "ghcr.io/danpatten/stingstream-node",
    "tags": ["v$VERSION", "latest"]
  }
}
EOF

if command -v jq > /dev/null 2>&1; then
    jq . "$OUT" > /dev/null || { echo "Generated $OUT is not valid JSON" >&2; exit 1; }
fi

echo "Wrote $OUT:"
cat "$OUT"
