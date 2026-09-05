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
| `--web-dist <DIR>` | serve a built web bundle at `/` (default: `apps/stingstream/dist` in `--dev`, `<install>/web` otherwise) |
| `--join-code <CODE>` | join a group from an invite code on start; also `$STINGSTREAM_JOIN_CODE` |
| `--join-code-file <PATH>` | read that code from a file instead; also `$STINGSTREAM_JOIN_CODE_FILE` |
| `--healthcheck` | ask a node at `--data-dir` whether it is healthy, exit 0/1, start nothing |

Ctrl+C stops the node. On Unix the children get a `SIGTERM` and a grace period first; on Windows
they are terminated (see "Known limitations").

### Joining a group with nobody at the keyboard

A seedbox comes up with no one to run the join call by hand, so it can be told the invite code up
front. This is what `deploy/coordinator/compose.yml`'s `storage-node` profile uses, and it is
exactly the same `MeshNode::join` the API performs — including being **idempotent**, so leaving the
value set across restarts refreshes membership rather than failing on a group already joined.

```powershell
# The straightforward form.
$env:STINGSTREAM_JOIN_CODE = "3Nk9…"

# Better, and what a container or a systemd unit should do: an invite code carries the group
# *secret*, and an environment variable is visible in `docker inspect` and /proc/<pid>/environ.
# A path can be a compose secret, a systemd LoadCredential=, or a 0600 file.
$env:STINGSTREAM_JOIN_CODE_FILE = "/run/secrets/stingstream-invite"
```

The file wins when both are set, so a deployment that has moved to the safer form is not silently
overridden by a stale variable in an `.env`.

**Joining and finding somebody are different things**, and this is the part worth knowing. A join
succeeds even when neither the inviter nor the group's coordinator answers: the group exists here,
its gossip topic is live, and a member that appears later is found. But the usual *reason* nobody
answered is that the code is wrong, the inviter is switched off, or the coordinator has not
finished starting — so the node retries on a backoff for about half an hour, warns in a full
sentence when it gives up, and reports where it got to on `/healthz`:

```powershell
(Invoke-RestMethod http://127.0.0.1:8790/healthz).join
# state      : local_only
# group      : 5f0c…
# name       : The Attic
# attempts   : 8
```

`state` is one of `off` (no code configured — most nodes), `joining`, `joined` (a member answered),
`local_only` (in the group, sharing with nobody yet) or `failed` (the code does not decode; not
retried, because it never will). A `local_only` node is *not* unhealthy and `/healthz` still
answers 200 — restart-looping its container would not introduce it to anybody.

### The web UI

Once `apps/stingstream` has been exported, the gateway serves it at `/` with no configuration:

```powershell
cd apps/stingstream
bun install
npx expo export --platform web        # writes apps/stingstream/dist
```

In `--dev` the node finds `apps/stingstream/dist` on its own. `--web-dist <DIR>` or
`gateway.web_dist` points somewhere else. A directory with no `index.html` in it is treated as
absent and the node serves its placeholder page, which is what a half-finished export leaves
behind. `index.html` is served with `no-cache` and content-hashed assets with `immutable`, and any
path that is not a file falls back to `index.html` so the app's own routing works — except a path
that looks like an asset, which gets a real 404 (a missing `.js` answered with HTML fails as
"Unexpected token '<'" somewhere unrelated, and that is a bad afternoon).

### The mesh

The mesh runs **inside the supervisor's process** by default. There is no `stingstream-mesh`
child, but the mesh still binds its loopback API port — `StingStream.Core` and the app both talk to
it over HTTP — and `/healthz` reports it as a child called `mesh` so a node's state is one document.

```powershell
# From this machine only: the raw mesh API, unauthenticated.
curl http://127.0.0.1:8790/stingstream/mesh/v1/status

# From anywhere, behind Jellyfin's own auth: the same operations.
curl -H "Authorization: MediaBrowser Token=\"$token\"" `
     http://127.0.0.1:8790/stingstream/api/v1/mesh/status
```

`[mesh] embedded = false` in `config.toml` goes back to supervising the `stingstream-mesh` binary,
which is how you attach a debugger to just the mesh. `[children] mesh = false` turns the mesh off
entirely; the node is then a complete single-node server with no group.

### The HTTPS side door

A node with a coordinator behind it also serves HTTPS on the same port, under three hostnames a
browser can reach it at — see [`SIDEDOOR.md`](SIDEDOOR.md). Two things about that are worth knowing
before they surprise you:

* **`http://127.0.0.1:8790` keeps working.** The gateway looks at the first byte of each connection
  and answers TLS or plain HTTP accordingly, so everything in this document, every `tools/e2e-*.ps1`
  and every `curl` habit is unaffected by a node that has a certificate. A plain request from
  *another machine* is redirected to `https://` once one exists.
* **Nothing happens without a coordinator that serves a zone.** With none — the zero-server default
  — `/healthz` reports `"side_door": {"state": "no_zone"}` and the node carries on. That is not a
  fault. `[sidedoor] enabled = false` turns the whole thing off.

```powershell
# What the side door is doing, and why it is not doing more.
(Invoke-RestMethod http://127.0.0.1:8790/healthz).side_door | ConvertTo-Json -Depth 5

# The end-to-end acceptance: a coordinator, a local Pebble, a real certificate, a real tunnel.
powershell -File tools/e2e-sidedoor.ps1
```

---

## Running two nodes on one machine

Which is what you want for anything to do with groups, and what `tools/e2e-m3.ps1` automates. Two
nodes need three things kept apart: a data directory, a gateway port, and every child port.

```powershell
$repo = "E:\Dan\Documents\Repos\StingStream"

foreach ($n in @(
    @{ Name = "a"; Port = 8890 },
    @{ Name = "b"; Port = 8990 }
)) {
    $dir = "E:\Dan\Documents\Repos\.win-temp\stingstream-$($n.Name)"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    @"
node_name = "node-$($n.Name)"

[gateway]
bind = "127.0.0.1"
port = $($n.Port)

[ports]
jellyfin = 0
radarr = 0
sonarr = 0
nzbget = 0
mesh = 0
"@ | Set-Content -Path "$dir\config.toml" -Encoding utf8

    Start-Process -FilePath "$repo\mesh\target\debug\stingstream.exe" `
        -ArgumentList '--dev', '--repo-root', $repo, '--data-dir', $dir
}
```

`0` means "pick a free port", so nothing collides — with the other node or with a node someone else
on the machine already has running. Each node's real ports land in its own `runtime.json`.

Then, with a Jellyfin token from each node (`POST /jellyfin/Users/AuthenticateByName`):

```powershell
# A creates a group with no coordinator at all.
$g = irm -Method POST http://127.0.0.1:8890/stingstream/api/v1/mesh/groups `
      -Headers $authA -ContentType application/json -Body '{"name":"Attic"}'

# A mints an invite; B joins with it.
$i = irm -Method POST "http://127.0.0.1:8890/stingstream/api/v1/mesh/groups/$($g.group)/invite" -Headers $authA
irm -Method POST http://127.0.0.1:8990/stingstream/api/v1/mesh/groups/join `
    -Headers $authB -ContentType application/json -Body (@{ code = $i.code } | ConvertTo-Json)

# What each node can now see.
irm "http://127.0.0.1:8890/stingstream/api/v1/mesh/groups/$($g.group)/index" -Headers $authA
irm "http://127.0.0.1:8890/stingstream/api/v1/mesh/peers?group=$($g.group)" -Headers $authA

# Force a materialization pass rather than waiting for the fifteen-second timer.
irm -Method POST http://127.0.0.1:8890/stingstream/api/v1/mesh/federated/refresh -Headers $authA
```

Add `"coordinator": "https://…"` to the create body for a group that uses one; the invite carries
it to every member, so nobody else has to type it. It is not permanent — since M4.5 a group's
coordinator can be changed, and every member follows over gossip within a second:

```powershell
# Point the group somewhere else. `"coordinator": null` puts it back on public infrastructure.
irm -Method PUT "http://127.0.0.1:8890/stingstream/api/v1/mesh/groups/$($g.group)/coordinator" `
    -Headers $authA -ContentType application/json `
    -Body (@{ coordinator = "https://coord.example.org" } | ConvertTo-Json)

# B follows without being asked. (Codes already handed out still work; new ones carry the new value.)
irm "http://127.0.0.1:8990/stingstream/api/v1/mesh/groups" -Headers $authB
```

See `docs/MESH.md`, "Changing a group's coordinator", for the conflict rule.

> **Run from a private copy of the build outputs.** A running node holds `mesh/target/debug/` and
> `server/*/bin/` open, which means nobody can rebuild while it is up — including you, and
> including whoever else is working in the repository. Copy the outputs somewhere else and use
> `--install-root`, or accept that your node has to stop for every build. On a machine where
> several people (or several agents) share one checkout, this is not a nicety.

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
tls/
  cert.pem             the node's own certificate chain, and its key next to it
  key.pem              generated here, never sent anywhere (see SIDEDOOR.md)
  account.json         the ACME account
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
node you already have running.

> **It has no `-PrivateCopy`, unlike `tools/e2e-m4.ps1`** — its node runs straight out of the
> repository's build outputs, so while it is up (and especially with `-KeepRunning`) nobody can
> `dotnet build server/jellyfin/Jellyfin.Server`. Worse on Windows: stopping the *supervisor* by
> name orphans its children rather than taking them with it (see "Known limitations in M1"), so a
> node you believe you have stopped can still be holding `StingStream.Core.dll`. If a build fails
> with `MSB3027 … locked by: Jellyfin.Server`, look for orphaned `jellyfin.exe`, `Radarr.Console.exe`
> and `nzbget.exe` whose *paths* are under `server/**` and `third_party/**` and stop those too. Giving
> this harness the same `-PrivateCopy` treatment M4's has — `New-PrivateInstallRoot -WithArrs` in
> `tools/e2e-common.ps1` copies the arrs as well — is the real fix and is still to do. Its work directory lives beside the repository, not inside it, and
it runs the node's children at `debug` — the arrs say nothing useful at `info` about why an import
was rejected, and the logs it leaves behind are the whole point when a step fails.

A passing run takes about two minutes on a warm machine and prints a timed line per step. When one
fails, the first place to look is `<work>/logs/` (the harness's own processes) and
`<work>/data/logs/` (the node's), plus the arr's own file log at `<work>/data/<app>/logs/`, which
is where the import decisions live.

### `tools/e2e-m3.ps1` — the federated library

The M3 test: two complete nodes, a group with nothing behind it, and a peer's film playing out of
your own Jellyfin. It reuses the M1 pipeline to populate node B, then starts node A empty, has A
create a group with **no coordinator**, has B join with A's invite code, and asserts the whole
chain — index, materialization, poster, badges, three separate playback paths, the unavailable tag
when B goes away and its removal when B comes back.

```powershell
powershell tools\e2e-m3.ps1                                  # the whole thing
powershell tools\e2e-m3.ps1 -SkipBuild -SkipCoordinator      # when iterating
powershell tools\e2e-m3.ps1 -KeepRunning                     # leave both nodes up
```

`-SkipCoordinator` drops the two steps that talk to Dan's Railway coordinator. They need the
internet and they cost metered egress on his bill, so CI skips them; everything else runs on
loopback and needs nothing hosted by anyone.

Gateway ports default to 8890 (A, the watcher) and 8990 (B, the holder), with ephemeral child
ports, so the harness does not collide with a development node. It also turns the mesh's gossip
timings down in each node's `mesh.toml` — five-second heartbeats and a fifteen-second peer timeout
rather than the shipped 20/60 — so the "B went offline" assertion measures the same behaviour
without the run spending a minute on it. The assertion itself is still against the sixty seconds
the milestone asks for.

**Use `powershell`, not `pwsh`, on Dan's machine**: only Windows PowerShell 5.1 is installed there.
Both harnesses run under either, and CI uses `pwsh` on Linux. The two binary steps — the byte-exact
range read and the full-file comparison — go through `System.Net.Http.HttpClient` rather than
`Invoke-WebRequest`, because 5.1 refuses to put `Range` in a plain header hashtable and handles a
binary body differently from `pwsh`.

One step is a *finding* rather than a pass/fail: "Episode multi-version support on this Jellyfin"
writes two versions of one episode into one Season folder and reports whether they became one item
with two MediaSources. The answer is printed under **Findings** at the end of the run and recorded
in `docs/ARCHITECTURE.md`.

### `tools/e2e-m4.ps1` — source selection, failover and pin

The M4 test: three nodes, two encodes of one film, and a source choice that has to be right.

```powershell
powershell tools\e2e-m4.ps1                                    # the whole thing
powershell tools\e2e-m4.ps1 -SkipBuild                         # when iterating
powershell tools\e2e-m4.ps1 -PrivateCopy E:\...\m4-run         # see below
powershell tools\e2e-m4.ps1 -KeepRunning                       # leave all three nodes up
```

Node A watches and holds nothing. Node B is a fast holder with three films, one of them Big Buck
Bunny at 1080p. Node C is a *deliberately slow* holder — capped at 1 MB/s and one concurrent stream
by the mesh's own `[peer] throttle_bytes_per_sec` and `max_concurrent_streams` — with the same film
at 2160p and a byte-identical copy of one of B's, so same-hash failover has somewhere to go.

Two things about it are worth knowing before reading a failure.

**No arrs.** All three nodes run Jellyfin and the mesh and nothing else. B and C are pure holders
whose media is placed on disk with a `movie.nfo` carrying the TMDB id, which makes the item key
deterministic without a metadata provider having to be reachable, and A's only add is one the group
already satisfies, which never reaches an arr. That takes the run from twelve child processes to
six. The consequence is that the pin step exercises the *direct Jellyfin import* branch rather than
the arr rescan; both are real paths and `PinService` documents when each applies.

**The media is encoded constant-bitrate, and that is load-bearing.** A colour-bar test pattern is a
static image, so with an ordinary `-b:v 20M` x264 compresses twelve seconds of 4K to a couple of
hundred kilobytes. The bitrate the scorer then reads out of the group index is fiction, every source
"fits" every link, and Speed-first and Quality-first return the same answer — a green run that
proves nothing. `-minrate` with `nal-hrd=cbr` is what makes a 4K source really need 20 Mbit/s. The
harness fails the generation step outright if a clip comes out at less than half its target size.

When a step fails, the first place to look is `<work>/logs/node-*.err.log` — the supervisor's
structured log, which is where the mesh's own `tracing` output goes, including the scorer's decision
line (`Source order for … under speed_first: …` with every candidate's score and reasons) and every
failover. `<work>/node-*/logs/` has the same per-child. The CI job uploads all three nodes' logs and
node A's federated tree on failure.

Gateway ports default to 8880 (A), 8980 (B) and 9080 (C), with ephemeral child ports, so it does not
collide with a development node or with the M3 harness.

`tools/e2e-common.ps1` holds the shared plumbing — steps, process management, HTTP, node lifecycle.
`tools/e2e-m3.ps1` still carries its own copies on purpose: it is a passing acceptance record for a
shipped milestone and it runs in CI, and switching it over would mean re-running the whole
800-second M3 acceptance to prove the move changed nothing. When M3's harness next needs to change
for another reason, that is when its helpers move.

### `tools/e2e-m7.ps1` — watch together, subtitles, recordings, and two bugs

```powershell
pwsh tools/e2e-m7.ps1 -SkipBuild -PrivateCopy E:\stingstream-e2e-m7-bin
```

Three nodes, no arrs and no NZBGet -- nothing here grabs anything, and B's and C's media is placed
on disk with an NFO carrying the TMDB id, so the run needs no metadata provider to be reachable.

| | |
|---|---|
| A | watches, and leads the watch party. Holds nothing. |
| B | holds the film, its English subtitle sidecar, and a DVR recording. Joins from `STINGSTREAM_JOIN_CODE`. |
| C | holds byte-identical copies, so a stream that has to fail over has somewhere to go. |

What it asserts, in order:

1. B's recordings folder is a *recordings* folder as far as Live TV's own configuration is
   concerned, and the recording resolves into an item.
2. B publishes a subtitle sidecar with its inventory record, and the index carries it as a
   described track.
3. **B joins from an invite code in its environment** -- the path
   `deploy/coordinator/compose.yml`'s `storage-node` profile depends on -- and `/healthz` says
   `join.state = joined` with a `via` that is not `none`.
4. A materializes the film and **the subtitle lands beside the `.strm`**, named the way Jellyfin
   finds an external track.
5. The recording appears in A's **Shared Recordings** and plays.
6. **A publishes nothing it only points at.** This is the cause of the M5 bug asserted directly:
   A's own inventory must contain neither the film's nor the recording's item key, because A holds
   only pointers to them -- and A's pointers must survive a rebuild, because the old loop deleted
   them.
7. **A holder that lost its file is walked past.** B's film is deleted with nobody told; a stream
   naming B still arrives byte-exact from C, and A stops offering B for that title.
8. Two sessions on **one** node share a native SyncPlay group on a peer's recording, which is the
   half Jellyfin already does and M7 only had to verify.
9. A leads a watch-together session, B joins, each seats the bridge in its own SyncPlay group, and
   after play, pause and seek **both nodes' positions stay inside one second** -- read from each
   node's own API, which is the same question a viewer in each room would be asking.
10. The leader knows its follower's drift and round trip, and ending the session takes the invite
    down on the other node.

The subtitle provider is mocked -- the sidecar is written onto B's disk -- because what is under
test is the publish-and-fetch half. Whether OpenSubtitles answers today is OpenSubtitles' business,
and an acceptance run that depended on it would fail for reasons that have nothing to do with this
repository.

### `-PrivateCopy`: not holding the repository's build outputs open

A running node holds `mesh/target/debug/` and `server/*/bin/` open, so nobody can rebuild while it is
up — including you, and including whoever else is working in the checkout. On a machine several
people (or several agents) share, that is not a nicety.

`-PrivateCopy <dir>` makes the M4 harness copy the supervisor, Jellyfin's build output and ffmpeg
into `<dir>` laid out as an install root, and run the nodes from there with `--install-root`:

```powershell
powershell tools\e2e-m4.ps1 -SkipBuild `
    -PrivateCopy E:\Dan\Documents\Repos\.win-temp\m4-run `
    -WorkDir     E:\Dan\Documents\Repos\.win-temp\m4-work
```

The copy is made once and reused; `-Force` remakes it after a rebuild. CI has a checkout to itself
and does not use it.

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
- **InfiniDysk is not wired in.** `children.infinidysk` is off; enabling it fails with a clear
  message.

---

## Known limitations after M4

- **`/stream/*` on the gateway is unauthenticated.** It has to be — a browser or a cast receiver
  reaching the side door has no Jellyfin token — and a request needs a 32-byte group id, an item
  key and a node id to fetch anything, so it is not enumerable. Tightening it is on M8's list.
- **A title held locally still hides its remote copies from the library.** The local file wins and
  no pointer is written, which is right; but the remote copies are then only reachable through
  `GET /items/{id}/sources` and the mesh, not as extra Jellyfin versions. Exposing them as versions
  of an arr-managed file is still deferred, because both arrs treat `.strm` as a video file.
- **Restart-by-timestamp is the client's half, and the client does not do it yet.** The mesh resumes
  transparently between holders of the *same* bytes; a different encode needs the player to restart
  at a timestamp on the next `MediaSource`. Everything it needs is in PlaybackInfo — the ordered
  list, and each source's hash as its weak `ETag` — but the app work is M5's.
- **Source-side transcoding is still not a thing.** When a link cannot carry a source, the *home*
  node transcodes it, pulling the original over the mesh. Asking the holder to transcode instead
  would save that bandwidth and is the obvious refinement, but it needs the holder's Jellyfin in the
  path and a way to authenticate to it, which is a later milestone.

Closed since M3b, for the record: the transcode of a federated source now works (see
`docs/ARCHITECTURE.md`, "The transcode fix"), and a title held by several nodes now materializes one
`.strm` version per holder.
