#!/usr/bin/env bash
set -euo pipefail

# Open backend + frontend in two Ghostty tabs (macOS / Ghostty 1.3+).
# Requires Automation permission for the calling app to control Ghostty.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Start local NzbDav backend and frontend in two Ghostty tabs.

Usage: scripts/dev-ghostty.sh [run-backend.sh options...]

Defaults to rebuilding the backend (--build) so a stale publish cannot
silently 404 new API routes. Pass --no-build to skip the rebuild.

Examples:
  ./scripts/dev-ghostty.sh
  ./scripts/dev-ghostty.sh --no-build
  ./scripts/dev-ghostty.sh --no-migrate
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "scripts/dev-ghostty.sh only supports macOS Ghostty AppleScript." >&2
  exit 1
fi

if [[ ! -d /Applications/Ghostty.app ]]; then
  echo "Ghostty.app not found at /Applications/Ghostty.app" >&2
  exit 1
fi

# Default to --build so local starts pick up new controllers/routes.
BACKEND_ARGS=("$@")
if [[ ${#BACKEND_ARGS[@]} -eq 0 ]]; then
  BACKEND_ARGS=(--build)
fi

BACKEND_CMD="./scripts/run-backend.sh"
for arg in "${BACKEND_ARGS[@]}"; do
  BACKEND_CMD+=" $(printf '%q' "$arg")"
done

FRONTEND_CMD="npm run dev"
if [[ ! -d "$ROOT_DIR/frontend/node_modules" ]]; then
  FRONTEND_CMD="npm install && npm run dev"
fi

# Escape for AppleScript double-quoted strings.
as_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

ROOT_AS="$(as_escape "$ROOT_DIR")"
FRONTEND_DIR_AS="$(as_escape "$ROOT_DIR/frontend")"
BACKEND_CMD_AS="$(as_escape "$BACKEND_CMD")"
FRONTEND_CMD_AS="$(as_escape "$FRONTEND_CMD")"

osascript <<EOF
tell application "Ghostty"
  activate

  set backendCfg to new surface configuration
  set initial working directory of backendCfg to "$ROOT_AS"

  set win to new window with configuration backendCfg
  delay 0.3
  set backendTerm to focused terminal of selected tab of win
  input text "$BACKEND_CMD_AS" to backendTerm
  send key "enter" to backendTerm

  set frontendCfg to new surface configuration
  set initial working directory of frontendCfg to "$FRONTEND_DIR_AS"

  set frontendTab to new tab in win with configuration frontendCfg
  delay 0.2
  set frontendTerm to focused terminal of frontendTab
  input text "$FRONTEND_CMD_AS" to frontendTerm
  send key "enter" to frontendTerm

  select tab (tab 1 of win)
end tell
EOF

echo "Ghostty: tab 1 backend ($BACKEND_CMD), tab 2 frontend ($FRONTEND_CMD)"
echo "UI: http://localhost:5173"
