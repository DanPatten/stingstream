# Installing StingStream

Companion to [`docs/RUNNING.md`](RUNNING.md) (running a node from a checkout, for development) and
[`docs/RELEASING.md`](RELEASING.md) (how these artifacts get built and published). This document is
for someone downloading a release, not building one.

Every install method produces the same thing: one node listening on **`http://localhost:8790`**,
running Jellyfin, Radarr, Sonarr, NZBGet and the StingStream mesh behind a single login. See
`deploy/node/LAYOUT.md` for exactly what is inside.

---

## Windows

1. Download `StingStream-Setup-<version>-win-x64.exe` from the
   [latest release](https://github.com/DanPatten/stingstream/releases/latest).
2. Run it. It needs administrator privileges — it installs a Windows service, opens a firewall
   port, and writes to `%ProgramFiles%`.
3. It installs to `%ProgramFiles%\StingStream`, creates `%ProgramData%\StingStream` as the data
   directory, registers and starts **StingStream** as a Windows service, opens TCP 8790 in Windows
   Firewall, and adds a Start Menu shortcut.
4. Open the Start Menu shortcut, or go to <http://localhost:8790> — first run creates the Jellyfin
   administrator account for you; watch the shortcut's target page or the log for the generated
   password (`%ProgramData%\StingStream\logs\stingstream.jsonl`) if you land on a login screen with
   nothing else to go on.

**Silent install** (for automation): `StingStream-Setup-<version>-win-x64.exe /VERYSILENT
/NORESTART /SUPPRESSMSGBOXES` — the same switches winget uses (`deploy/windows/winget/`).

**Service**: registered as `StingStream`, running the supervisor's own `--service` mode
(`mesh/crates/stingstream/src/service.rs`) rather than a generic wrapper like NSSM — see
`docs/RELEASING.md` "The service-mode approach" for why. Manage it with the Services console, or:

```powershell
Get-Service StingStream
Restart-Service StingStream
Stop-Service StingStream    # graceful: every child gets its stop signal and a grace period first
```

**Uninstalling**: Settings → Apps → StingStream → Uninstall, or the Start Menu's own uninstall
shortcut. This stops and removes the service, removes the firewall rule, and deletes
`%ProgramFiles%\StingStream`. **`%ProgramData%\StingStream` (your data, config and media) is left
behind by default** — delete it by hand (`Remove-Item -Recurse -Force
"$env:ProgramData\StingStream"`) for a truly clean uninstall.

**winget**: `deploy/windows/winget/` holds a manifest set ready to submit to
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) once a real release exists — see
`docs/RELEASING.md` "Submitting to winget". Not yet submitted; there is no `winget install
stingstream` today.

---

## Linux (.deb — Debian, Ubuntu and derivatives)

1. Download `stingstream_<version>_amd64.deb` (or `_arm64.deb`) from the
   [latest release](https://github.com/DanPatten/stingstream/releases/latest).
2. `sudo apt install ./stingstream_<version>_amd64.deb` (apt resolves the dependencies listed
   below; `sudo dpkg -i` plus `sudo apt-get install -f` works too).
3. The package creates a `stingstream` system user, installs to `/opt/stingstream`, and starts the
   `stingstream.service` systemd unit automatically. `curl http://localhost:8790/healthz` should
   answer within a few seconds to a couple of minutes (three self-contained .NET applications are
   starting up behind it).

**Dependencies** installed automatically: `libicu72`, `libfontconfig1`, `libfreetype6` (needed by
the self-contained .NET publishes and Jellyfin's image processing). `p7zip-full` is recommended,
not required, for archive formats NZBGet's own bundled tools do not cover.

**Data directory**: `/var/lib/stingstream`. **Install tree**: `/opt/stingstream` (read-only from
the running node's point of view — an upgrade replaces it wholesale).

**Service**:

```sh
sudo systemctl status stingstream
sudo systemctl restart stingstream
sudo systemctl stop stingstream       # graceful: SIGTERM, then a 30s grace period (unit's TimeoutStopSec)
sudo journalctl -u stingstream -f
```

**Uninstalling**: `sudo apt remove stingstream` (or `purge`) stops and disables the service.
**`/var/lib/stingstream` is left behind by both `remove` and `purge`**, matching the Windows
installer's behaviour — `sudo rm -rf /var/lib/stingstream` for a truly clean uninstall. The
`stingstream` system user is also left in place (ordinary Debian packaging convention for system
users, in case anything else on the machine still references it).

**arm64**: built and published the same way, but only the amd64 leg's install is actually verified
in CI (a real, unemulated systemd boot on the GitHub Actions runner) — see `docs/RELEASING.md`
"Known packaging quirks" for why arm64 is build-verified only. **No NZBGet on arm64**: nzbgetcom
publishes no arm64 Linux release asset; the node still comes up with NZBGet reported disabled in
`/healthz`.

---

## Linux (AppImage — any distribution, no install, no root)

For a desktop user who would rather not add a systemd service. Download
`StingStream-<version>-x86_64.AppImage` (or `-aarch64.AppImage`), `chmod +x` it, and run it:

```sh
chmod +x StingStream-*.AppImage
./StingStream-*.AppImage
```

Data lives at `~/.local/share/stingstream` by default (`$STINGSTREAM_DATA` overrides it, same as
everywhere else). There is no service manager involved — the AppImage is the node process itself,
running in the foreground (or backgrounded with `&`/a terminal multiplexer/your desktop's own
autostart mechanism) for as long as you want it up.

---

## Docker

```sh
docker run -d --name stingstream -p 8790:8790 \
  -v stingstream-data:/data \
  -v /path/to/your/media:/data/media \
  ghcr.io/danpatten/stingstream-node:latest
```

Or `docker compose -f deploy/node/compose.yml up -d` for the same thing with less typing — see that
file for what each environment variable and volume does. `linux/amd64` and `linux/arm64` are both
published under the one tag; Docker picks the matching one automatically.

**Joining a group on first run**: set `STINGSTREAM_JOIN_CODE` to an invite code (see
`docs/RUNNING.md` for how to mint one from another node) before starting the container, or use
`deploy/coordinator/compose.yml`'s `storage-node` profile to run a node alongside a
self-hosted coordinator on the same host. Either way this is exactly the same `MeshNode::join` a
manual `POST /stingstream/mesh/v1/groups/join` call would do — see
`mesh/crates/stingstream/src/main.rs` — and it is safe to leave the variable set across restarts.

**Updating**: `docker compose pull && docker compose up -d` (or `docker pull
ghcr.io/danpatten/stingstream-node:latest && docker restart stingstream`). Docker users update by
tag, not through the node's own update check (see `docs/RELEASING.md` "The update check").

**Health**: the image's own `HEALTHCHECK` runs `stingstream --healthcheck`, visible in `docker ps`
and `docker inspect`.

---

## macOS

**Unsigned and unnotarized. Signing/notarization is deferred** — this project has no Apple
Developer ID today, and without one, Gatekeeper will refuse to run a downloaded, quarantined binary
without an explicit user override (`xattr -d com.apple.quarantine <path>`, or "Open Anyway" in
System Settings → Privacy & Security, after the first blocked launch attempt). This is expected
behaviour on macOS for any unsigned binary from the internet, not a bug in the package.

What exists today:

- `StingStream-<version>-osx-x64.tar.gz` / `-osx-arm64.tar.gz`: the same install tree every other
  platform gets (`deploy/node/LAYOUT.md`), built and lightly smoke-tested on real GitHub-hosted Mac
  runners in `.github/workflows/release.yml` (`stingstream --version` and `--print-runtime`
  succeed) — genuine proof the binaries run on macOS, not just that they cross-compile. **Full
  multi-child startup (Jellyfin, Radarr, Sonarr, NZBGet all actually coming up together) has not
  been verified on macOS anywhere**, and neither has an end user's actual download-and-run
  experience with Gatekeeper's quarantine attribute in the way.
- `deploy/macos/stingstream.rb`: a Homebrew formula **template**, wired to install the tarball
  above via `libexec` and to start it under `launchd` with `brew services`. Also unverified — no
  Mac has run `brew install` against it. See that file's own header for exactly what a real
  submission needs (real checksums once a release exists, and very likely code signing before
  homebrew-core's own review would accept it).

To try it anyway, once you accept the Gatekeeper prompt:

```sh
tar -xzf StingStream-<version>-osx-arm64.tar.gz -C ~/stingstream
xattr -d com.apple.quarantine ~/stingstream/bin/stingstream   # if Gatekeeper blocks it
~/stingstream/bin/stingstream --install-root ~/stingstream --data-dir ~/.local/share/stingstream
```

Signing and notarization, and a real `brew install stingstream`, are follow-up work that needs an
Apple Developer Program membership Dan does not currently have — see `docs/RELEASING.md` "Known
gaps and what Dan needs to provide" for the concrete unblock.

---

## Android

Not distributed through this document — `docs/APP-RELEASE.md` owns Android identity, signing and
the Play Store listing. `.github/workflows/release.yml` attaches whichever unsigned APK/AAB
`app.yml`'s own build most recently produced (best-effort; may be absent from a given release) as a
convenience for testing, never as the intended install path — signing stays local, per
`docs/APP-RELEASE.md`.

---

## Ports, firewall, and where things live

| | Windows | Linux (.deb) | Linux (AppImage) | Docker |
|---|---|---|---|---|
| Gateway port | 8790 (TCP) | 8790 (TCP) | 8790 (TCP) | published however you map it |
| Install tree | `%ProgramFiles%\StingStream` | `/opt/stingstream` | wherever you keep the `.AppImage` | inside the image, at `/app` |
| Data directory | `%ProgramData%\StingStream` | `/var/lib/stingstream` | `~/.local/share/stingstream` | the `/data` volume |
| Runs as | a Windows service | a systemd unit, user `stingstream` | your own user, foreground | the container's own `stingstream` user |
| Firewall | opened automatically (TCP 8790) | not touched — open it yourself for LAN access | not touched | whatever you publish with `-p` |

A firewall rule (or `-p`/port mapping) only matters for reaching the node from **another** machine.
`http://localhost:8790` always works locally with no firewall involved.

## The update check

Every node polls a small `version.json` once a day (see `docs/RELEASING.md` "The update check") and
`/healthz` reports the latest version it found. **Docker users are not covered by this** — an image
tag never changes itself; `docker compose pull` (or your own watchtower-style automation) is how a
container updates. Turn the check off entirely with `[updates] enabled = false` in `config.toml` if
you would rather this node made no outbound calls of its own.

## Getting help

<https://github.com/DanPatten/stingstream/issues>. Include `/healthz`'s output and the relevant
`logs/*.jsonl` file (`docs/RUNNING.md` "Reading the logs") — almost everything worth diagnosing is
in one of those two places.
