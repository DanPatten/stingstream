#!/bin/sh
# Take ownership of the data directory, then stop being root.
#
# A mounted volume arrives owned by **root**, on Railway and on a plain `docker run -v` alike. The
# service runs unprivileged, so with nothing in between the very first thing it does is fail to
# create its own database:
#
#     Error: opening the accounts database
#     Caused by: unable to open database file: /data/accounts.db
#
# and the container crash-loops while the platform still reports it healthy for a while, which is a
# miserable thing to debug.
#
# The alternative — running the whole service as root — would work and is what most images do. It is
# not worth it here: this process is the front door to everybody's accounts and is reachable from the
# public internet, so the few lines below buy a real reduction in what a compromise reaches.
set -e

if [ "$(id -u)" = "0" ]; then
    # Only the data directory, and only if it exists. `-R` is safe because nothing else lives here:
    # the database, the signing key, and nothing else (see `docs/ACCOUNTS.md`).
    if [ -d "${STINGSTREAM_ACCOUNTS_DATA:-/data}" ]; then
        chown -R stingstream:stingstream "${STINGSTREAM_ACCOUNTS_DATA:-/data}"
    fi
    # `setpriv` from util-linux, which is already in the base image — no gosu or su-exec to vendor.
    # `--init-groups` so the process's supplementary groups are the user's own rather than root's
    # inherited set, and `exec` so the service is PID 1 and gets the platform's SIGTERM directly
    # rather than through a shell that would ignore it.
    exec setpriv --reuid=stingstream --regid=stingstream --init-groups \
        /usr/local/bin/stingstream-accounts "$@"
fi

# Already unprivileged: whoever started this container chose the user, so respect it and do not
# pretend the chown above happened.
exec /usr/local/bin/stingstream-accounts "$@"
