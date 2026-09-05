#!/bin/sh
# nfpm postinstall: fix ownership on whatever just landed under /opt/stingstream's data-adjacent
# bits, then enable and (re)start the service. Safe on both a fresh install and an upgrade --
# `systemctl restart` on a package that was not previously running just starts it.
set -e

chown -R stingstream:stingstream /var/lib/stingstream

if command -v systemctl > /dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl daemon-reload
    systemctl enable stingstream.service
    systemctl restart stingstream.service
else
    echo "systemd not detected -- start StingStream by hand: /opt/stingstream/bin/stingstream --install-root /opt/stingstream --data-dir /var/lib/stingstream" >&2
fi

exit 0
