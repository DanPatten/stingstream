#!/bin/sh
# nfpm preremove: stop the service before dpkg starts removing files out from under it.
set -e

if command -v systemctl > /dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl stop stingstream.service > /dev/null 2>&1 || true
fi

exit 0
