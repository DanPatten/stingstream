---
name: reload-node
description: Reload a local StingStream node so a code change is actually the code being served. Covers which rebuild a change needs, which changes need no restart at all, and how to keep two nodes running side by side without one clobbering the other. Use when a change needs testing in a real node, when an edit "isn't showing up" in the browser, or when starting, stopping or refreshing a local instance.
---

# Reloading a local node

The question this answers: **I changed a file — what do I have to do for the running node to be
serving that change, and nothing else?**

## The answer is `tools/dev.ps1`

```powershell
powershell tools\dev.ps1            # both pinned nodes
powershell tools\dev.ps1 -Node 1    # just node 1
```

It works out which of `apps/stingstream`, `server/jellyfin` and `mesh` changed since it last ran,
builds only those, re-exports the web bundle only when app source moved, syncs only the files that
differ into each node's private copy, and restarts a node only when a binary actually changed. A
web-only change restarts nothing. Nothing changed at all takes under a second.

**Prefer it to every manual sequence below.** The manual commands are still correct and are what
`dev.ps1` runs, but each one is a step you have to remember, and the failures are silent: a bundle
exported before the commit you are looking at serves the previous UI with no error anywhere, and a
`-ForceCopy` you forgot leaves a node on old binaries while printing that all is well.

Useful flags: `-Strict` (build Jellyfin with its analyzers on, which is what "it builds" has to
mean before a commit — the fast path turns them off and says so), `-Fresh` (wipe the data dirs for
a genuine first run), `-Force` (rebuild and re-sync everything, for when you suspect the change
detection rather than the code), `-SkipBuild` (sync and restart from the outputs already on disk).

**If you are an agent, run it in the background and read its output from a file.** Anything that
starts a node leaves `stingstream.exe` holding the console it inherited, so a tool that captures
stdout and waits for end-of-stream waits for the *node*, not the script — the command looks hung
for its full timeout while having actually finished in seconds. The node is fine; the capture is
not. Redirect and background it:

```powershell
powershell tools\dev.ps1 2>&1 | Out-File -Encoding utf8 <logfile>   # with run_in_background
```

Everything below is the manual equivalent, for when something has gone wrong and you need to drive
one step at a time.

Every command here is `tools/ui-node.ps1`, run from the repository root. Do not use
`cargo run -- --dev` (`docs/RUNNING.md`): it runs the node out of `mesh/target/debug/` and holds it
open, which blocks every other session's rebuild — `docs/CONTRIBUTING.md` rule 3.

---

## There are two nodes. Do not create a third.

Both already exist and stay up between sessions. Everything below is done against one of them —
never a new data directory, never another port. This is a standing rule in `CLAUDE.md`; the ~40
dead directories under `.local\ui-loop\` are what it exists to stop.

| | URL | `-DataDir` | `-PrivateCopy` | `-WebDist` |
|---|---|---|---|---|
| **node 1** | `http://127.0.0.1:5173` | `.local\e2e-A\data` | `.local\e2e-A\bin` | `.local\ui-loop\web-dist` |
| **node 2** | `http://127.0.0.1:8802` | `.local\e2e-B\data` | `.local\e2e-B\bin` | `.local\ui-loop\web-dist` |

Node 1 for ordinary work; node 2 as well when the change needs a second party — sharing, invites,
federation, watch-together. Every example below shows node 1; node 2 is the same command with
`e2e-B` and `-Port 8802`.

`tools/ui-node.ps1` still defaults to `-Port 8795` and `.local\ui-loop\data`, which is *not* this
pair — so **`-DataDir`, `-PrivateCopy` and `-Port` are always passed explicitly**, and always
absolute.

---

## The one rule

**An instance is identified by its data directory, not its port.**

`-Stop` and `-Fresh` find a node by scanning running command lines for the `-DataDir` path and
killing only the processes that match (`Stop-Owned`, `tools/e2e-common.ps1:483`). That is what lets
several nodes share this machine safely — and it means every command typed against an instance must
carry the same `-DataDir` the start command did.

**Use absolute paths.** The matcher compares the *resolved* path, and a relative `-DataDir` is
resolved against the shell's current directory. Run `-Stop` from a different folder than the node
was started from and it prints "stopped", stops nothing, and the next `-ForceCopy` fails on a
locked `stingstream.exe` with no hint as to why.

Before touching anything, see what is actually up:

```powershell
Get-CimInstance Win32_Process | Where-Object Name -eq 'stingstream.exe' | ForEach-Object { $_.CommandLine }
```

Expect exactly two lines, `--port 5173` and `--port 8802`. A third is a violation of the pinned-pair
rule rather than a colleague's work — stop it by its own `--data-dir` and say so. The exception is a
`tools/e2e-*.ps1` run in progress under `.local\e2e\`: those build their own throwaway nodes and stop
them in their `finally`, so leave a live harness alone and let it clean up.

---

## Reload by what changed

| Changed | What it takes |
|---|---|
| `apps/stingstream/**`, with a Metro dev server attached | nothing — fast refresh |
| `apps/stingstream/**`, Tier B | re-export, refresh the browser |
| `mesh/**` (Rust) | stop → `cargo build` → `-ForceCopy` start |
| `server/jellyfin/**` (incl. `StingStream.Core`) | stop → `dotnet build` → `-ForceCopy` start |
| `<DataDir>\config.toml` | stop → start (no `-ForceCopy`) |
| first-run, setup or schema behaviour | `-Fresh` |

### Web / UI only — no node restart, ever

**Tier A** (edit visible in seconds). One Metro dev server, and a node that proxies `/` to it:

```powershell
cd apps\stingstream
bunx expo start --web --port 8081      # never `bun run start` — it runs git submodule update
```

```powershell
powershell tools\ui-node.ps1 -DataDir E:\Dan\Documents\Repos\StingStream\.local\e2e-A\data -Port 5173 -DevServer http://127.0.0.1:8081
```

Then open the **node's** URL, never Metro's on `:8081` — Jellyfin's `CorsHosts` is deliberately
empty and the gateway adds no CORS of its own, so a browser pointed straight at Metro loads the
shell and reaches no API at all. Fast refresh does the reloading; the node stays up across every
edit.

**Tier B** — what ships, and what every screenshot is taken against:

```powershell
cd apps\stingstream
bunx expo export --platform web --output-dir E:\Dan\Documents\Repos\StingStream\.local\ui-loop\web-dist
```

Then just refresh the browser. **No node restart:** the gateway reads the bundle off disk per
request (`gateway/web.rs`, via `web_asset`), `index.html` is served `no-cache`, and assets are
content-hashed and `immutable` — so an ordinary refresh gets the new build, and there is no service
worker in the way.

The one condition: **that directory must have held an `index.html` when the node started.**
`resolve_web_dist` runs once at startup (`mesh/crates/stingstream/src/main.rs`), and a directory
with no `index.html` is resolved to "no bundle" for the life of the process. Exporting into it
afterwards changes nothing — the placeholder page keeps coming back until the node is restarted.
This is the single most common "my change isn't showing up".

### Rust — stop first, always

```powershell
powershell tools\ui-node.ps1 -DataDir E:\Dan\Documents\Repos\StingStream\.local\e2e-A\data -Stop
cargo build --manifest-path mesh/Cargo.toml -p stingstream
powershell tools\ui-node.ps1 `
  -DataDir     E:\Dan\Documents\Repos\StingStream\.local\e2e-A\data `
  -PrivateCopy E:\Dan\Documents\Repos\StingStream\.local\e2e-A\bin `
  -WebDist     E:\Dan\Documents\Repos\StingStream\.local\ui-loop\web-dist `
  -Port 5173 -ForceCopy
```

`cargo build` itself is safe while a node runs — the node runs from the private copy, not from
`target/debug`. It is the sync into that private copy that needs the node down: it overwrites
`stingstream.exe` and the Jellyfin assemblies, and Windows will not let you write a file a running
process has open. `-ForceCopy` no longer means anything (the copy is always a delta now), but the
node still has to be stopped before one is made.

### .NET (Jellyfin, StingStream.Core) — the same shape

```powershell
powershell tools\ui-node.ps1 -DataDir E:\Dan\Documents\Repos\StingStream\.local\e2e-A\data -Stop
dotnet build server/jellyfin/Jellyfin.Server/Jellyfin.Server.csproj -c Debug
powershell tools\ui-node.ps1 `
  -DataDir     E:\Dan\Documents\Repos\StingStream\.local\e2e-A\data `
  -PrivateCopy E:\Dan\Documents\Repos\StingStream\.local\e2e-A\bin `
  -WebDist     E:\Dan\Documents\Repos\StingStream\.local\ui-loop\web-dist `
  -Port 5173 -ForceCopy
```

### config.toml — restart, no rebuild

`<DataDir>\config.toml` is written on first start and never rewritten. Edit it, `-Stop`, start
again. `-Fresh` regenerates it from the script's defaults, losing those edits.

### Starting over

```powershell
powershell tools\ui-node.ps1 `
  -DataDir     E:\Dan\Documents\Repos\StingStream\.local\e2e-A\data `
  -PrivateCopy E:\Dan\Documents\Repos\StingStream\.local\e2e-A\bin `
  -WebDist     E:\Dan\Documents\Repos\StingStream\.local\ui-loop\web-dist `
  -Port 5173 -Fresh
```

`-Fresh` stops anything running against that data dir and wipes it, so the next start is a genuine
first run. This is how you get a first run **on a pinned node** — wiping node 1 and starting it again
is right; standing up a fresh instance somewhere else to avoid the wipe is not. It is the only way to get the setup screen and first-run wiring back. It does **not**
refresh the binaries — combine it with `-ForceCopy` when the code changed too.

---

## The second node

Node 2 is already running. Bring it into the picture when the change needs a second party — sharing,
invites, federation, watch-together — and otherwise leave it be. It is the same command with `e2e-B`
and `-Port 8802`:

```powershell
powershell tools\ui-node.ps1 `
  -DataDir     E:\Dan\Documents\Repos\StingStream\.local\e2e-B\data `
  -PrivateCopy E:\Dan\Documents\Repos\StingStream\.local\e2e-B\bin `
  -WebDist     E:\Dan\Documents\Repos\StingStream\.local\ui-loop\web-dist `
  -Port 8802
```

**`-PrivateCopy` is the one that bites**, and it is why the pair has two of them. It defaults to the
shared `.local\ui-loop\bin`, so a `-ForceCopy` that forgets the flag refreshes binaries the other
node is running from: it fails outright on the locked `stingstream.exe` if that node is up, and
where it does not fail the result is a node whose files no longer match its own process. Paired with
a `-Stop` that matched nothing (the absolute-path trap above), this reads as a mystery rather than a
collision. **A rebuild both nodes should pick up is two `-Stop`s, one build, two `-ForceCopy`
starts** — not a new instance built from scratch.

**`-WebDist` is shared on purpose.** Both nodes serve `.local\ui-loop\web-dist`, so one
`bunx expo export` into it reloads both with no restart. Do not split it.

Ports: 5173 and 8802 are the only ones to pick, and the only ones that may be passed. Every child
takes an ephemeral port recorded in `<DataDir>\runtime.json`, so the two nodes collide on nothing
else.

---

## Traps, in the order they are usually hit

1. **Exported, still seeing the placeholder page.** The node started with an empty `-WebDist`.
   Restart it; nothing else will fix it.
2. **`-Stop` says "stopped", nothing stopped.** A relative `-DataDir`, or a different one than the
   node was started with. Read the real one off the command line and pass it absolute.
3. **`-ForceCopy` fails on a locked exe.** A node is still running from that `-PrivateCopy` — either
   the one you meant to stop (see trap 2), or the other pinned node because `-PrivateCopy` was
   omitted and defaulted to the shared `.local\ui-loop\bin`. Stop it, and pass the node's own
   `-PrivateCopy`.
4. **Rebuilt, but the node behaves as before.** `cargo build`/`dotnet build` alone changes nothing
   the node can see; `-ForceCopy` is what moves the new binary into the private copy.
5. **New media does not appear.** A library that already exists does not rescan on a timer fast
   enough for an interactive loop. `POST /jellyfin/Library/Refresh`, or place the files before the
   node's first start (`docs/UI-LOOP.md`).

Companions: `docs/UI-LOOP.md` (the loop this tooling was built for), `docs/RUNNING.md` (what a node
is, `config.toml` and `runtime.json`), `docs/CONTRIBUTING.md` (rule 3: never run a node out of the
repository's own build outputs).
