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

## Finishing means committed and pushed

**Committing and pushing your own work is the last step of doing it, not a separate request.** When
a piece of work is finished, commit it and push to `master` without being asked. Finished work left
sitting in the working tree is invisible to everyone else and one stray command in another session
away from gone, and the person who would have to reconstruct it is not the one who left it there.

Finished means finished: it builds, whatever you touched passes (`cargo clippy --workspace
--all-targets -- -D warnings`, `bun run typecheck`, `bun test`), the workspace is not left broken
for anyone else (CONTRIBUTING rule 2), and any line in this file or in `docs/**` that your change
made untrue is fixed in the same commit. Work still in flight stays uncommitted; say so rather than
committing half of it.

The staging discipline does not relax — it is what makes committing-by-default safe:

- `git add <explicit file paths>` for the files you changed. Never `git add -A`, never `git add .`,
  never a directory.
- Then read `git diff --cached --stat` and the diff itself, and confirm every staged hunk is yours.
  A file you edited can also hold somebody else's half-finished change. If a hunk is not yours,
  leave that file out of the commit and say which one and why.
- Stage and commit in one invocation, then `git push`.

Everything else in git stays read-only and asked-for-first: `checkout`, `restore`, `switch`,
`reset`, `revert`, `clean`, `stash`, `merge`, `rebase`, `cherry-pick`, anything `--force`. Undo your
own edits by hand, with an editor. If a push is rejected because `master` moved, stop and ask — the
fix is a write.

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
names that `-DataDir`, so every command typed against an instance must carry the same absolute
`-DataDir` the start command did.

## Two nodes, pinned. Never a third.

**The two local instances already exist. Do not create another one** — not for a screenshot, not to
check one thing, not a private copy of your own, not "just this once". There are two, they stay up
between sessions, and everything is done on them:

| | URL | `-DataDir` | `-PrivateCopy` | `-WebDist` |
|---|---|---|---|---|
| **node 1** | `http://127.0.0.1:8801` | `.local\e2e-A\data` | `.local\e2e-A\bin` | `.local\ui-loop\web-dist` |
| **node 2** | `http://127.0.0.1:8802` | `.local\e2e-B\data` | `.local\e2e-B\bin` | `.local\ui-loop\web-dist` |

Paths are shown relative to the repository root; pass them **absolute**
(`E:\Dan\Documents\Repos\StingStream\...`), because a relative `-DataDir` resolves against the
shell's current directory and a `-Stop` that misses prints "stopped" having stopped nothing. Both
nodes share one `-WebDist`, so a single `bunx expo export --platform web --output-dir
.local\ui-loop\web-dist` refreshes both.

- **8801 and 8802 are the only gateway ports.** One node's worth of work goes to node 1; anything
  needing a second party — sharing, invites, federation, watch-together — uses node 2 as well.
  Nothing needs a third.
- **Always pass `-Port` and `-DataDir` explicitly.** `tools/ui-node.ps1` still defaults to
  `-Port 8795` and its own `.local\ui-loop\data`, which is *not* the pinned pair — a bare invocation
  creates exactly the stray instance this rule forbids.
- **Never invent a new data directory.** The ~40 under `.local\ui-loop\` are dead per-task instances
  from before this rule. They are the mess it exists to stop, not a pattern to copy.
- **`tools/e2e-*.ps1` are the one exception, and a narrow one.** They build throwaway nodes under
  `.local\e2e\` because `e2e-m4` and `e2e-m7` genuinely need three. **They must stop those nodes when
  they finish.** That is already the default — every harness's `finally` calls `Stop-Tools`.
  `-KeepRunning` is what leaks a node, so **do not pass it**; if you already have, stop the nodes by
  their data directories before moving on.
- **A third node is a rule violation, not a colleague's work.** Before starting or stopping anything,
  list what is up; if anything other than 8801 and 8802 is running, stop it by its `-DataDir` and say
  so:

```powershell
Get-CimInstance Win32_Process | Where-Object Name -eq 'stingstream.exe' | ForEach-Object { $_.CommandLine }
```

Dan, 2026-09-10: *"we keep spinning up new local instances, lets stop that and pin 2 ports going
forward and NOTHING else, no one is allowed to create new instances, tests must use those 2
instances."*

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

## The voice of user-facing copy

StingStream should read like a product people pay for: plain, calm, professional. This binds the
same surfaces as the rule above. `apps/stingstream/translations/en.json`, toasts, empty states,
button labels, confirmation dialogs, and any error text that reaches a screen. It does not bind
code, comments, logs, `docs/**` or this file.

- **The best copy is no copy.** Text is the last resort, not the first. Before writing a sentence
  onto a screen, ask whether an icon, a familiar control, sensible defaults, disabled states,
  placeholder text, or the layout itself could carry the same meaning. Explain only what a person
  genuinely cannot work out from the interface.
- **Lean on the patterns people already know.** Settings rows with toggles, a search field with a
  magnifier, a kebab menu, an inline validation message under the field, a tooltip on hover, an
  empty state with one action button. These are the conventions every SaaS product shares, and a
  reader arrives already fluent in them. A paragraph explaining a control is usually a sign the
  control is wrong, not that the paragraph is missing.
- **No em dashes.** Use a full stop, a comma, a colon, or brackets. Two short sentences almost
  always beat one sentence carrying a dashed aside. `apps/stingstream/brand.test.ts` fails on one
  in `en.json`; the other locales are their translators' own business.
- **Say what happened, then what to do about it.** "A first run can take a few minutes. Try again,
  or check that StingStream is running on your server." The reasoning behind a rule belongs in a
  comment or in `docs/**`, never on the screen.
- **Second person, active voice, present tense.** "Your server has not answered yet", not "The
  server could not be reached".
- **No jokes, no apologies, no exclamation marks, no scare quotes, and nothing chatty.** Never
  editorialise about the software's own behaviour.
- **One idea per string.** If a message needs three clauses to be true, the screen probably needs a
  title and a line, not a longer sentence.

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
