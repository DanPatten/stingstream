# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

This file is an index, not a manual. Where it points at a document, read that document before
relying on assumptions: most of these rules exist because their absence already cost someone a day,
and the reason is written down where the rule lives.

`apps/stingstream/CLAUDE.md` is the app's own, and is loaded on top of this one when working in
there. This file is about the monorepo.

## Keeping this file true

Loaded into context every session, so a stale line here is not a missing answer, it is a confident
wrong one. When a change makes something here inaccurate, update it in the same commit.

## The checkout is shared

Several people, or several agents, work in this working tree at once. `git status` showing files
you never touched is the normal state, not an anomaly. Everything that follows from that —
private build copies, staging by explicit path, never leaving the workspace broken — is
[`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md), seven rules, all of them load-bearing.

Read it before the first commit in a session. The two that catch people first:

- **Rule 3**: never run a node out of `mesh/target/debug/` or `server/*/bin/`. A running node holds
  those open and nobody — including you — can rebuild. Copy them and use `--install-root`.
- **Rule 4**: `git add <explicit paths>`, never `git add -A` or `git add .`, and stage and commit in
  one invocation. A broad add sweeps up another session's in-flight work and publishes it under
  your name at a moment its author did not choose.

## Seeing a change actually run

**Use the [`reload-node`](.claude/skills/reload-node/SKILL.md) skill.** It is the single procedure
for getting an edit in front of you, and it exists because the wrong guess here fails silently: an
exported bundle that the node will never look at, a `-Stop` that stops nothing, a rebuilt binary the
node never picked up. Invoke it any time a change needs testing in a real node, or an edit is not
showing up.

The shape of it, so the rest of this file makes sense:

| Changed | What it takes |
|---|---|
| `apps/stingstream/**`, Metro dev server attached | nothing — fast refresh |
| `apps/stingstream/**`, built bundle | re-export, refresh the browser |
| `mesh/**` (Rust) | stop → `cargo build` → restart with `-ForceCopy` |
| `server/jellyfin/**` (incl. `StingStream.Core`) | stop → `dotnet build` → restart with `-ForceCopy` |
| `<DataDir>\config.toml` | stop → start |
| first-run, setup or schema behaviour | restart with `-Fresh` |

Nodes are started, stopped and refreshed with `tools/ui-node.ps1`, and **an instance is identified
by its data directory, not its port** — `-Stop` and `-Fresh` only touch processes whose command line
names that `-DataDir`. Two instances therefore need two of everything: `-DataDir`, `-PrivateCopy`,
`-WebDist` and `-Port`. Before starting or stopping anything, list what is already running, because
other sessions run nodes here too:

```powershell
Get-CimInstance Win32_Process | Where-Object Name -eq 'stingstream.exe' | ForEach-Object { $_.CommandLine }
```

## Building

```powershell
# The node: Rust supervisor + gateway + mesh, and the Jellyfin fork carrying StingStream.Core.
cargo build --manifest-path mesh/Cargo.toml
dotnet build server/jellyfin/Jellyfin.Server/Jellyfin.Server.csproj -c Debug

# The arrs, which we do not patch. Each pins its own SDK band in its own global.json.
dotnet build server/radarr/src/Radarr.sln     # SDK 8
dotnet build server/sonarr/src/Sonarr.sln     # SDK 10

# The app. bun only — yarn's hoisting introduces a second react-native-screens that crashes
# Android at startup, which no bundler check catches. CONTRIBUTING.md rule 5.
cd apps/stingstream && bun install && bun run typecheck && bun test
```

`tools/e2e-*.ps1` are the end-to-end harnesses: `m1` one node, `m3` two nodes and a federated
library, `m4` source selection and failover, `m6` requests, `m7` watch-together, subtitles and
recordings, `m8` revocation, `invite` a person invited into a group ending up watching a film held
by a third node. Each starts real nodes; none of them mocks the sharing path.

## StingStream is one app

**Nothing the user reads may present StingStream as a bundle of other people's applications.** Not
by name — Radarr, Sonarr, NZBGet, Jellyfin — and not by shape: no "both apps", no "the two apps
disagree", no "Create in both apps", no "the movie manager and the series manager" as two things a
person has to keep in step. A person installed one program. That it supervises several processes is
an implementation detail of ours, and every place a screen leaks it turns a working feature into a
chore the reader is now responsible for coordinating.

This binds **user-facing copy**: `apps/stingstream/translations/en.json`, toasts, empty states,
button labels, confirmation dialogs, error messages that reach a screen. Say what the *node* does —
"Saved", "Synced", "StingStream could not reach the indexer" — not which child process did it.

It does **not** bind code, comments, docblocks, logs, `docs/**` or this file. Internally the names
are the honest ones and should stay: `ArrClientFactory`, `radarr`/`sonarr` in `config.toml`,
`child_radarr` in a log line. A developer debugging a child needs its real name.

Dan, 2026-09-09, on finding "Create in both apps" on the quality screen: *"NEVER say create in both
apps — StingStream is a single app and the combination of sonarr/radarr should never be referenced
as such."*

## Where things are documented

| Topic | Document |
|---|---|
| Design, decisions, what each milestone shipped | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Running a node, `config.toml`, `runtime.json`, flags | [`docs/RUNNING.md`](docs/RUNNING.md) |
| Building it, repository layout | [`docs/DEVELOPING.md`](docs/DEVELOPING.md) |
| The shared-checkout rules | [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) |
| The UI iterate loop, screenshots, golden startup | [`docs/UI-LOOP.md`](docs/UI-LOOP.md) |
| Mesh wire protocol, groups, swarming | [`docs/MESH.md`](docs/MESH.md) |
| The app: building, embedded mesh, releases | [`docs/APP-DEV.md`](docs/APP-DEV.md), [`docs/APP-MESH.md`](docs/APP-MESH.md), [`docs/APP-RELEASE.md`](docs/APP-RELEASE.md) |
| Screen map and API client | [`docs/UI.md`](docs/UI.md) |
| HTTPS for a browser, invites, requests | [`docs/SIDEDOOR.md`](docs/SIDEDOOR.md), [`docs/INVITES.md`](docs/INVITES.md), [`docs/REQUESTS.md`](docs/REQUESTS.md) |
| Every patch to vendored code, and why | [`docs/PATCHES.md`](docs/PATCHES.md) |
| Installing and releasing | [`docs/INSTALL.md`](docs/INSTALL.md), [`docs/RELEASING.md`](docs/RELEASING.md) |
