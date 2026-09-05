# Releasing StingStream

M8a: packaging, installers and the release pipeline. Companion to
[`docs/INSTALL.md`](INSTALL.md) (what a user does with the result) and
[`deploy/node/LAYOUT.md`](../deploy/node/LAYOUT.md) (what is inside every artifact).

---

## Versioning

`0.<milestone>.<n>` until 1.0 — e.g. `0.8.0` for M8a's first release, `0.8.1` for a fix respin
inside the same milestone, `0.9.0` once M9 (if there is one) ships. `<n>` resets to `0` at the start
of a new milestone. This is a repository-wide version, not per-component: the Rust binaries, the
Windows installer, the `.deb`, the AppImage, the macOS tarball and the Docker image tag all carry
the same number for one release. `1.0.0` is a deliberate decision Dan makes, not something a
milestone counter reaches on its own.

The Rust workspace's own `Cargo.toml` files still say `0.1.0` — that is cargo's own internal
package version (semver, used for dependency resolution inside the workspace) and is a separate
number from the *release* version this document is about. Nothing here currently keeps them in
sync; `tools/package-node.ps1`/`.sh`'s `-Version`/`--version` flag and `.github/workflows/release.yml`
are what the release version actually flows through.

---

## Doing a release

1. Decide the version, e.g. `0.8.0`. Update anything that should say so out loud (this file's own
   examples do not count; there is currently no single file that needs bumping for this — the
   version comes from the git tag itself).
2. **Dry run first.** Trigger `.github/workflows/release.yml` via `workflow_dispatch` with that
   version as input, from the Actions tab or:
   ```sh
   gh workflow run release.yml -f version=0.8.0
   ```
   This runs every build, package and verification step exactly as a real release would, and stops
   before creating a GitHub Release or retagging the Docker image (see that workflow's `release`
   job — its release-creating steps are gated on `needs.version.outputs.is_tag == 'true'`, which a
   dispatch run never sets). Confirm every job is green, and pull the workflow's own artifacts if
   you want to inspect an installer or package by hand before it becomes a real release.
3. **Push the tag.** Only once the dry run is green:
   ```sh
   git tag v0.8.0
   git push origin v0.8.0
   ```
   This is a real, standing, and rarely-reversible action — a pushed tag with an already-published
   GitHub Release and Docker image tags is not something to casually delete and re-push. Get
   explicit sign-off before doing this for a real (non-`-rc`) version; a `v0.8.0-rc1` pre-release
   tag is the lower-stakes way to exercise the exact same pipeline end-to-end, including the
   GitHub-Release-creation step a dry run skips (the trigger is `v*`, so an `-rc` tag runs the full
   pipeline, including `release`'s tag-gated steps — GitHub marks a tag containing a hyphen as a
   **pre-release** automatically when using `generate_release_notes`, which is exactly the
   "obviously not the stable download" signal an `-rc` should carry).
4. Watch `.github/workflows/release.yml`. It builds, packages, verifies and publishes everything
   in parallel jobs, then a final `release` job assembles the GitHub Release. See "What each job
   does" below for what to expect from each one and roughly how long it takes.
5. Check the release page: every artifact present, `SHA256SUMS` and `version.json` both attached,
   release notes auto-generated from merged PRs/commits since the last tag.
6. Check `https://github.com/DanPatten/stingstream/releases/latest/download/version.json` resolves
   (this is the stable URL the update check polls — see "The update check" below).
7. If winget or Homebrew submission is in scope for this release, see their own sections below.

---

## What each job does, and where each thing is verified

| Job | Runs on | Produces | Verified how |
|---|---|---|---|
| `windows-installer` | `windows-latest` | `StingStream-Setup-<v>-win-x64.exe` | Builds and packages for real; the installer itself is compiled by Inno Setup on the runner. **Not** silently installed in CI (needs elevation a CI runner does not casually grant); see "Known gaps" for what that leaves unverified. |
| `linux-packages` (linux-x64) | `ubuntu-latest` | `stingstream_<v>_amd64.deb`, `StingStream-<v>-x86_64.AppImage` | The `.deb` is genuinely installed on the runner (a real Ubuntu VM with real systemd — not a container, not emulated) and `stingstream.service` is checked against `/healthz` and `journalctl`, then removed again with a check that `/var/lib/stingstream` survives. |
| `linux-packages` (linux-arm64) | `ubuntu-latest` (cross-compiled) | `stingstream_<v>_arm64.deb`, `StingStream-<v>-aarch64.AppImage` | Build-verified only — an arm64 binary cannot execute on the runner's x86_64 CPU, and QEMU-emulating a full five-process boot for a CI smoke test was judged not worth its time cost against what the linux-x64 leg already proves about the same postinst/unit file. |
| `macos` (osx-arm64, osx-x64) | `macos-14`, `macos-13` | `StingStream-<v>-osx-*.tar.gz` | Builds on **real Mac hardware** (GitHub-hosted macOS runners — the one place in this whole project that is true) and runs `stingstream --version` and `--print-runtime` for real. Full multi-child startup is **not** verified anywhere; see "Known gaps". |
| `android-unsigned` | `ubuntu-latest` | unsigned phone/TV APKs | Reuses `app.yml`'s own `android-release-unsigned` job's artifacts rather than rebuilding (cheap, per this milestone's brief) — best-effort, and silently omitted from the release if no matching run exists within its 7-day artifact retention. |
| `release` | `ubuntu-latest` | `SHA256SUMS`, `version.json`, the GitHub Release, a retagged Docker image | Gated on Windows, Linux and macOS all succeeding; Android is allowed to fail without blocking a release. |

The node **Docker image** is not built by `release.yml` at all — `.github/workflows/images.yml`
publishes `ghcr.io/danpatten/stingstream-node:<sha>` and `:latest` on every push to `master`
(mirroring `coordinator.yml`'s own pattern for the coordinator image), and `release.yml`'s `release`
job only **retags** the image already built for the tagged commit with the release version
(`docker buildx imagetools create`, which copies a manifest rather than rebuilding). This means a
release tag should be pushed against a commit that is already on `master` and has already had
`images.yml` run against it — tagging an arbitrary older commit will build everything else
correctly but the image-retag step will find nothing to retag (it is `continue-on-error`, so this
does not fail the release; check the GHCR tags by hand if that happens).

---

## Known packaging quirks (found doing this, not decided in advance)

- **Radarr publishes through its own `-t:PublishAllRids` MSBuild target**; Jellyfin and Sonarr
  publish through a plain `dotnet publish <single project>`. Not a style choice — a plain
  `dotnet publish server/sonarr/src/NzbDrone.Console/Sonarr.Console.csproj` needs `-f net10.0`
  (multi-targeted project) and `-p:RunAnalyzersDuringBuild=false` (a StyleCop `SA1200` violation in
  `Sonarr.RuntimePatches/Mono/*.cs` only surfaces once analyzers run against a **self-contained
  RID-specific** publish, which nothing before M8a had ever actually exercised — `dotnet build`
  without a RID, which is all `ci.yml` does, never compiles that code path). Radarr's own tray
  application project (`NzbDrone/Radarr.csproj`) independently fails to *restore* under a plain
  `dotnet publish NzbDrone.Console/Radarr.Console.csproj` invocation with `NU1510` (a "package will
  not be pruned" warning-as-error against `System.Resources.Extensions`) if the whole solution is
  restored — its own official `-t:PublishAllRids` target avoids the problem by construction (it is
  upstream's own release mechanism, not something M8a invented), so that is what `tools/package-
  node.ps1`/`.sh` use for it instead of chasing the restore failure down. Both are pre-existing
  characteristics of the vendored subtrees, not new breakage — this is exactly the kind of thing a
  packaging milestone is supposed to surface. Worth an upstream issue against Sonarr's own
  `Directory.Build.props`/analyzer configuration at some point; not filed as part of this work.
- **Sonarr needs one more file that a plain `dotnet publish NzbDrone.Console` does not produce:
  its platform assembly.** Found by actually running the packaged win-x64 tree, not by inspection —
  Sonarr started, and every child but Sonarr reported healthy; Sonarr itself restarted three times
  and its own log showed `System.IO.FileNotFoundException: ... Sonarr.Windows.dll`.
  `NzbDrone.Common.Composition.AssemblyLoader` loads `Sonarr.Windows` or `Sonarr.Mono` **by name
  from the executable's own directory at runtime** (`OsInfo.IsWindows ? "Sonarr.Windows" :
  "Sonarr.Mono"`) rather than through a project reference `dotnet publish` would follow — Radarr's
  equivalent works only because its `-t:PublishAllRids` route builds the *whole* solution, platform
  projects included, not because Radarr does anything differently in principle. Fixed by building
  `NzbDrone.Windows/Sonarr.Windows.csproj` (or `NzbDrone.Mono/Sonarr.Mono.csproj` on every other
  RID) as one extra small library and dropping its one output DLL into the Sonarr output directory
  — see the comment at that step in `tools/package-node.ps1`/`.sh` and
  `deploy/node/Dockerfile`. All three now also assert the file is actually present before calling
  packaging done, specifically so this cannot silently regress.
- **Not trimmed.** `PublishTrimmed` is not used anywhere in `server/radarr/src/Directory.Build.props`
  or `server/sonarr/src/Directory.Build.props` (both explicitly set `SelfContained=false` as their
  own default, overridden per-publish), and ASP.NET Core plus Jellyfin's reflection-based plugin
  loader are not trim-safe without extensive annotation work neither upstream project has done.
  Self-contained-but-not-trimmed is what ships: no "install a matching .NET runtime first" step,
  at the cost of a larger download than trimming would produce. Sizes as packaged locally for
  `win-x64` (self-contained, unstripped `.pdb`s included): Jellyfin ≈ 280 MB, Radarr ≈ 156 MB,
  Sonarr ≈ 167 MB.
- **No linux-arm64 NZBGet.** `nzbgetcom/nzbget`'s releases have no arm64 Linux asset as of this
  writing (`third_party/nzbget/fetch-nzbget.ps1`'s own `$PlatformPatterns` only knows `win64`,
  `linux-x64`, `macos`). A linux-arm64 node ships with `bin/nzbget/` empty and NZBGet reported
  `Disabled` in `/healthz` — not a packaging bug, a real upstream gap. Fixed by either a future
  nzbgetcom release or building it from source for arm64, neither in scope here.

---

## The service-mode approach

**A proper Windows service, not a generic wrapper (NSSM, WinSW, etc.).** The supervisor gained an
additive `--service` mode (`mesh/crates/stingstream/src/service.rs`, using the `windows-service`
crate) that registers *itself* with the Service Control Manager, rather than being launched by a
wrapper process the SCM manages instead. The reason this matters: a wrapper can only ever hard-kill
whatever it launched when the SCM asks it to stop — it has no channel to tell the real process
"please shut down gracefully" that Windows reliably delivers to a console-less child (the exact
problem `docs/RUNNING.md`'s own "Known limitations" section documents one level down, for the
supervisor's *own* children). With `--service`, the SCM's stop control reaches the supervisor
directly and drives the same shutdown-watch-channel path Ctrl+C does at a console: every child gets
its stop signal and grace period before anything is killed, and `Stop-Service`/`net stop` block
until that has actually finished, not until a wrapper's own process happened to exit.

On Linux, `systemd` already does the equivalent job natively (a `Type=simple` unit with
`KillSignal=SIGTERM` and `TimeoutStopSec=30` — `deploy/linux/systemd/stingstream.service`) — no
in-process service mode was needed there, because systemd itself is the thing sending the signal
this project's own Unix Ctrl+C/SIGTERM handling already expects (`main.rs`'s
`wait_for_shutdown_signal`).

On macOS, `deploy/macos/stingstream.rb`'s Homebrew formula `service do ... end` block hands the
same job to `launchd`, for the same reason.

---

## The update check

`GET /healthz` on any node includes:

```json
{
  "version": "0.8.0",
  "latest_version": "0.8.1",
  ...
}
```

`version` is the running binary's own `CARGO_PKG_VERSION`. `latest_version` comes from a background
task (`mesh/crates/stingstream/src/updatecheck.rs`) that polls `version.json` once at startup and
every 24 hours after — `null` until the first successful poll, and permanently `null` on a node
with no route out, or with `[updates] enabled = false` in `config.toml`. The default URL is
GitHub's own stable "whichever release is marked latest" path:

```
https://github.com/DanPatten/stingstream/releases/latest/download/version.json
```

**This is deliberately the smallest useful half of "show update available".** Comparing `version`
against `latest_version` (a semver compare — is `0.8.1` actually newer than `0.8.0`, handling a
pre-release tag correctly) and surfacing a banner or notification somewhere a user will see it is a
UI decision that belongs to whoever owns that screen — today that is either `StingStream.Core`'s
own status endpoint (`/stingstream/api/v1/status`, see `docs/RUNNING.md`) mirroring the field
through, or the web app reading `/healthz` directly and rendering something when the two strings
differ. **Left as a TODO, not implemented here**, specifically so that surface can decide its own
semantics (dismissing a notification, per-channel opt-in, whatever a design pass wants) without a
second round of changes to the supervisor. Whoever picks this up next: the field is already there,
polled, and documented — the remaining work is entirely in Core/the app, not the node.

Docker users are not covered by this at all — an image tag never changes itself, and
`docker compose pull` (or your own automation) is the update mechanism there. `docs/INSTALL.md`
says so.

---

## Submitting to winget

`deploy/windows/winget/manifests/d/DanPatten/StingStream/0.8.0/` is a **template**, not yet
submitted. Once a real release exists:

1. Compute the installer's SHA256 from that release's own `SHA256SUMS` (already published as a
   release asset — no need to hash it yourself).
2. Update `DanPatten.StingStream.installer.yaml`'s `InstallerUrl` and `InstallerSha256`, and bump
   the version folder name and the `PackageVersion` field in all three manifest files to match.
3. Validate locally: `winget validate --manifest deploy/windows/winget/manifests/d/DanPatten/StingStream/<version>/`
   (needs the `winget` CLI; `winget install Microsoft.WingetCreate` also works and can generate/
   update the manifest interactively against a real URL).
4. Open a PR against [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) with the
   three files under `manifests/d/DanPatten/StingStream/<version>/`. Their own bot runs automated
   validation and installer testing before a human reviews it.

**This needs Dan**: nothing here requires new credentials, but the PR should come from (or be
reviewed by) whoever owns the `DanPatten` GitHub identity the manifest's `Publisher`/`PublisherUrl`
fields name.

---

## Known gaps and what Dan needs to provide

- **Code signing (Windows).** The installer and the `stingstream.exe` inside it are unsigned.
  Windows SmartScreen will warn on first run of an unsigned, downloaded executable. Fixing this
  needs an Authenticode code-signing certificate (EV strongly preferred — it gets SmartScreen
  reputation immediately rather than needing to accumulate download counts) and a place to run
  `signtool` in CI with the private key available as a secret. **Dan needs to purchase and provide
  this** if unsigned SmartScreen warnings are not acceptable long-term.
- **Code signing and notarization (macOS).** No package here is signed or notarized. This needs an
  Apple Developer Program membership (paid, annual) and `notarytool` credentials in CI. **Dan needs
  to enroll and provide these** before macOS distribution is anything more than "works if you
  fight Gatekeeper once."
- **winget submission** is written and ready (see above) but not submitted — it needs a real
  release to point at, which did not exist at the time this milestone's code was written, and then
  a PR from a human with standing in the `DanPatten` namespace.
- **Homebrew.** `deploy/macos/stingstream.rb` is a template with placeholder checksums; homebrew-
  core's own acceptance bar (<https://docs.brew.sh/Acceptable-Formulae>) very likely requires code
  signing before it would be accepted, so this realistically waits on the Apple Developer
  enrollment above. A personal tap (`brew tap danpatten/stingstream ...`) does not have that bar
  and could be stood up sooner, once someone with a Mac can verify the formula actually installs
  and starts.
- **Play Console** (Android): entirely out of this milestone's scope — see `docs/APP-RELEASE.md`,
  which already documents that signing stays local and a Play Console listing is a separate,
  not-yet-done piece of work needing Dan's own developer account.
- **macOS full-boot verification.** Nobody has started all five child processes together on macOS
  — only the binary launching and resolving its own config has been proven, on real CI hardware.
  The first real macOS user is, today, the first person to find out whether Jellyfin/Radarr/Sonarr/
  NZBGet actually come up together there.
- **Windows installer silent-install verification.** `deploy/windows/build-installer.ps1` compiles
  the installer and CI runs it, but nothing runs the installer **itself** (elevation, service
  registration, firewall rule) end-to-end in an automated way — that needs either a self-hosted
  Windows runner willing to grant a CI job admin rights, or continued manual verification on a real
  machine before each release. Verified manually on Dan's own machine for this milestone's initial
  build (see the M8a session's own report for what "manually" covered); not automated.

---

## `dist/` layout (all local, all gitignored)

```
dist/
├─ node/<rid>/            tools/package-node.ps1|sh's output -- deploy/node/LAYOUT.md's tree
├─ publish/<child>/<rid>/ raw dotnet publish output before assembly (jellyfin, sonarr)
├─ installers/            the final artifacts: .exe, .deb, .AppImage, .tar.gz
└─ appimage-work/<rid>/   scratch AppDir + appimagetool, safe to delete between runs
```

None of this is committed; `.gitignore`'s `dist/` entry (already present for the Expo web build)
covers it.
