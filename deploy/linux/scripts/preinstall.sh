#!/bin/sh
# nfpm preinstall: create the stingstream system user/group and the data directory before any
# file lands or the systemd unit is touched. Idempotent -- safe on an upgrade.
set -e

if ! getent group stingstream > /dev/null 2>&1; then
    addgroup --system stingstream
fi
if ! getent passwd stingstream > /dev/null 2>&1; then
    adduser --system --ingroup stingstream --home /var/lib/stingstream --no-create-home \
        --shell /usr/sbin/nologin stingstream
fi

mkdir -p /var/lib/stingstream
chown -R stingstream:stingstream /var/lib/stingstream

exit 0
