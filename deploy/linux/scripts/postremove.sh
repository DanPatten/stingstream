#!/bin/sh
# nfpm postremove: disable the unit. Deliberately does NOT remove /var/lib/stingstream, even on
# purge -- matches the Windows installer's "leaves the data dir behind by default" behaviour
# (deploy/windows/uninstall-service.ps1). Remove it by hand for a truly clean uninstall
# (docs/INSTALL.md "Uninstalling"), and remove the stingstream system user/group with it if wanted
# (deb packaging convention leaves system users in place on purge for the same reason: they may
# still own files elsewhere on the system).
set -e

if command -v systemctl > /dev/null 2>&1; then
    systemctl disable stingstream.service > /dev/null 2>&1 || true
    systemctl daemon-reload > /dev/null 2>&1 || true
fi

exit 0
