# Running a StingStream node

This is the practical companion to [`ARCHITECTURE.md`](ARCHITECTURE.md): how to build a node from
a clean checkout, run it, and find your way around it when something is wrong.

A node is one command and five processes. The command is `stingstream`; the processes are the
supervisor itself plus Jellyfin, Radarr, Sonarr and NZBGet, all bound to loopback behind a single
gateway port.

---

## What you need

| Toolchain | Why | Notes |
|---|---|---|
| Rust (stable) | the supervisor and gateway | `mesh/` is its own Cargo workspace |
| .NET SDK 8.0 | Radarr | pinned by `server/radarr/global.json` |
| .NET SDK 10.0 | Jellyfin and Sonarr v5 | pinned by their own `global.json` files |
| PowerShell 5.1+ or `pwsh` | the fetch scripts and the acceptance harness | Windows PowerShell is fine |

Install the SDKs side by side; that is supported, and no single version covers all three.

Two binaries are fetched rather than vendored, and a node will not do much without them:

```powershell
# ffmpeg for Jellyfin: without it there is no transcoding, no media probing and no images.
pwsh third_party/ffmpeg/fetch-jellyfin-ffmpeg.ps1

# NZBGet, the usenet download client.
pwsh third_party/nzbget/fetch-nzbget.ps1
```

Both default to the current platform and drop their output into gitignored `bin/` directories that
the supervisor discovers on its own. On Windows, installing 7-Zip lets the NZBGet script unpack the
vendor's NSIS installer without running it; without 7-Zip it falls back to a silent install into
that same directory.

---

## Build

```powershell
# The supervisor and gateway.
cargo build --manifest-path mesh/Cargo.toml -p stingstream

# Jellyfin, which now contains StingStream.Core.
dotnet build server/jellyfin/Jellyfin.Server/Jellyfin.Server.csproj -c Debug

# The two arr cores. Slow, and rarely need rebuilding.
dotnet build server/radarr/src/Radarr.sln -c Debug
dotnet build server/sonarr/src/Sonarr.sln -c Debug
```

`jellyfin-web` is deliberately *not* needed: the node runs Jellyfin with `--nowebclient` because
StingStream serves its own UI from the gateway (M2).

---

## Run

```powershell
cargo run --manifest-path mesh/Cargo.toml -p stingstream -- --dev
```

`--dev` means "run the children out of the in-repo build outputs, and proxy their own UIs through
the gateway for debugging". The repository root is detected from the working directory or from the
binary's own location; pass `--repo-root` if you are running from somewhere odd.

The node prints a banner naming everything you need:

```
StingStream node "attic" is up.
  Gateway      http://127.0.0.1:8790
  Health       http://127.0.0.1:8790/healthz
  StingStream  http://127.0.0.1:8790/stingstream/api/v1/
  Jellyfin     http://127.0.0.1:8790/jellyfin/
  Data         C:\Users\dan\AppData\Local\StingStream
  Mode         --dev (child UIs proxied at /radarr/, /sonarr/, /nzbget/)

  First run. The Jellyfin administrator account is being created as:
    username  stingstream
    password  Cj4o7pMZoefe8YQSd3w4n4jY
```

Useful flags:

| Flag | What it does |
|---|---|
| `--data-dir <DIR>` | node data directory; also `$STINGSTREAM_DATA` |
| `--port <N>` | gateway port (default 8790) |
| `--print-runtime` | resolve config, write `runtime.json`, print it, start nothing |
| `--no-children` | run the gateway alone, so you can start a child under a debugger |
| `--install-root <DIR>` | production mode: children live under `<DIR>/bin/<child>/` |

Ctrl+C stops the node. On Unix the children get a `SIGTERM` and a grace period first; on Windows
they are terminated (see "Known limitations").

---

## The data directory

Everything a node owns is under one directory: `%LOCALAPPDATA%\StingStream` on Windows,
`~/.local/share/stingstream` elsewhere, or wherever `$STINGSTREAM_DATA` / `--data-dir` points.

```
config.toml            your settings; written once with defaults, never rewritten
runtime.json           what was actually assigned this run (see below)
core.db               StingStream.Core's own SQLite database
logs/
  stingstream.jsonl    the supervisor's own log, JSON lines
  jellyfin.jsonl       everything Jellyfin wrote to stdout/stderr, wrapped per line
  radarr.jsonl         likewise
  sonarr.jsonl
  nzbget.jsonl
jellyfin/{config,data,cache,log}/
radarr/                Radarr's data directory, including its config.xml
sonarr/
nzbget/                nzbget.conf
downloads/
  torrents/<category>/ where the in-process engine puts things
  usenet/              NZBGet's MainDir
media/
  Movies/              Radarr's root folder, and Jellyfin's "Movies" library
  TV/                  Sonarr's root folder, and Jellyfin's "TV Shows" library
federated/             reserved for M3's .strm/.nfo materialization
```

### `config.toml`

Written with commented defaults on first run and never touched again, so your edits survive
upgrades. The interesting parts:

```toml
node_name = "attic"

[gateway]
bind = "0.0.0.0"    # the node's one exposed listener
port = 8790

[ports]             # preferences, not commands: a taken port falls back to an ephemeral one,
jellyfin = 8096     # and 0 always means "pick one"
radarr = 7878
sonarr = 8989
nzbget = 6789

[children]
infinidysk = false  # a later milestone
```

### `runtime.json`

The supervisor's contract with everything else on the node, rewritten on every start: the ports
that were really assigned, the generated arr API keys, the NZBGet and qBittorrent-shim credentials,
the Jellyfin bootstrap administrator, and the resolved paths. `StingStream.Core` reads it to reach
the arrs; `tools/e2e-m1.ps1` reads it to drive the node; you read it when you need an API key.

It holds secrets, so it is written owner-only where the OS supports it. Generated values are
carried forward across restarts — a restart never invalidates configuration that has already been
pushed into a child.

---

## Poking at a running node

```powershell
# Supervisor and child states. 200 when everything is healthy, 503 when not.
curl http://127.0.0.1:8790/healthz

# The StingStream API needs a Jellyfin token, because it *is* Jellyfin's auth.
$rt = Get-Content $env:LOCALAPPDATA\StingStream\runtime.json | ConvertFrom-Json
$auth = Invoke-RestMethod -Method POST http://127.0.0.1:8790/jellyfin/Users/AuthenticateByName `
  -Headers @{ Authorization = 'MediaBrowser Client="cli", Device="cli", DeviceId="cli", Version="1"' } `
  -ContentType 'application/json' `
  -Body (@{ Username = $rt.jellyfin_admin.username; Pw = $rt.jellyfin_admin.password } | ConvertTo-Json)
$h = @{ Authorization = "MediaBrowser Token=`"$($auth.AccessToken)`"" }

Invoke-RestMethod http://127.0.0.1:8790/stingstream/api/v1/status -Headers $h
Invoke-RestMethod http://127.0.0.1:8790/stingstream/api/v1/settings -Headers $h
Invoke-RestMethod http://127.0.0.1:8790/stingstream/api/v1/inventory -Headers $h
```

The API describes itself at `/stingstream/api/v1/openapi.json`.

In `--dev`, the children's own UIs are proxied for debugging — `/radarr/`, `/sonarr/`, `/nzbget/`.
An installed node never routes those; they are not StingStream's front door.

### Reading the logs

Everything is JSON lines, so `jq` (or PowerShell) works on all of it:

```powershell
# Just the supervisor's warnings.
Get-Content $env:LOCALAPPDATA\StingStream\logs\stingstream.jsonl |
  ConvertFrom-Json | Where-Object level -eq 'WARN'

# What Radarr said, as plain text.
Get-Content $env:LOCALAPPDATA\StingStream\logs\radarr.jsonl |
  ConvertFrom-Json | ForEach-Object { $_.line }
```

`RUST_LOG=debug` on the supervisor interleaves every child's output into its own log, prefixed with
the child's name — one view of the whole node.

---

## The acceptance harness

`tools/e2e-m1.ps1` is the test that decides whether M1 works. It builds everything, generates two
test media files with the fetched ffmpeg, seeds them from a self-hosted BitTorrent tracker, serves
them from a Torznab stub, starts a node on a throwaway data directory, adds a movie and a series
through the StingStream API, and waits for each to travel the whole path — grab, download through
the qBittorrent-compatible API, import, webhook, Jellyfin item — then plays them and restarts the
node to prove it all comes back.

```powershell
pwsh tools/e2e-m1.ps1                       # the whole thing
pwsh tools/e2e-m1.ps1 -SkipBuild            # when iterating
pwsh tools/e2e-m1.ps1 -KeepRunning          # leave the node up afterwards to poke at
```

It uses gateway port 8791 and ephemeral child ports, so it does not collide with a development
node you already have running. Its work directory lives beside the repository, not inside it, and
it runs the node's children at `debug` — the arrs say nothing useful at `info` about why an import
was rejected, and the logs it leaves behind are the whole point when a step fails.

A passing run takes about two minutes on a warm machine and prints a timed line per step. When one
fails, the first place to look is `<work>/logs/` (the harness's own processes) and
`<work>/data/logs/` (the node's), plus the arr's own file log at `<work>/data/<app>/logs/`, which
is where the import decisions live.

---

## When something is wrong

**A child keeps restarting.** `/healthz` reports `restarting` with a `last_exit`; the reason is in
`logs/<child>.jsonl`. The supervisor backs off exponentially to a minute, and resets the backoff
once a child has stayed up for a minute, so a child that crashes on start-up will not spin.

**Jellyfin will not start on a fresh node.** If you see
`SQLite Error 1: 'no such table: __EFMigrationsHistory'`, something has written
`IsStartupWizardCompleted=true` into `jellyfin/config/system.xml` before Jellyfin's first start.
That flag is how Jellyfin decides whether to create its database at all; the supervisor
deliberately never writes it, and `StingStream.Core` only sets it after the database exists.

**An import never appears in Jellyfin.** Check `/stingstream/api/v1/status` — `recentArrEvents`
shows every webhook the node received and what it did with it. No `Download` event means the arr
never called; an event with no refresh means the path in the payload was not one Jellyfin knows.

**The arrs cannot reach the download client.** `POST /stingstream/api/v1/setup/run` re-runs
first-run wiring, which is idempotent, and re-pushes the download clients with whatever ports the
current run assigned.

**A port moved.** That is normal: `[ports]` in `config.toml` is a preference. `runtime.json` always
has the truth, and every child was configured from it.

---

## Known limitations in M1

- **Windows shutdown is a hard stop.** There is no portable graceful stop for a child that does not
  share the supervisor's console — `GenerateConsoleCtrlEvent` needs a shared console group, and
  attaching to a child's console would signal the supervisor too. Unix gets `SIGTERM` and a grace
  period. In practice .NET's SQLite WAL survives termination; a hard kill of the *supervisor*
  (rather than Ctrl+C) does orphan the children on Windows, and they have to be stopped by name.
- **No mesh.** Groups, peers and the federated library arrive in M3. The inventory records are
  built and stored now so that M3 has something real to publish.
- **InfiniDysk is not wired in.** `children.infinidysk` is off; enabling it fails with a clear
  message.
