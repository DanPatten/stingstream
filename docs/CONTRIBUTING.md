# Working in this repository

Seven conventions, each of which exists because ignoring it cost someone real time. The rest of the
docs are per-component: `ARCHITECTURE.md` for the system, `MESH.md` for the mesh, `APP-DEV.md` and
`APP-MESH.md` for the app, `RUNNING.md` for running a node.

(`apps/stingstream/CONTRIBUTING.md` is upstream Streamyfin's own, about that project's process.
This file is about the StingStream monorepo.)

The thing that shapes all of this: **the checkout is shared.** Several people, or several agents,
work in one working tree at once. Your `git status` showing files you never touched is the normal
state, not an anomaly.

---

## 1. Spread the defaults of a struct you do not own

Constructing a struct from another crate field-by-field means the next field added there is *your*
build failure. Spread its defaults instead, and set only what you have an opinion about:

```rust
MeshConfig {
    node_name,
    peer: PeerConfig { light: true, ..PeerConfig::default() },
    ..MeshConfig::default()
}
```

Clippy will call that `needless_update` whenever the struct *happens* to be fully covered at that
moment — a lint that flips depending on whether somebody else's field has landed yet, and which
asks for the brittle version. Silence it at the site, with the reason:

```rust
// Spread rather than enumerate: MeshConfig belongs to stingstream-mesh and grows as the node
// does. Clippy calls this needless whenever the struct happens to be fully covered today.
#[allow(clippy::needless_update)]
```

## 2. Do not leave the workspace broken

Everyone here runs `cargo clippy --workspace --all-targets -- -D warnings`, and it walks the
working tree, not your commits. A half-finished crate registered in `mesh/Cargo.toml`, or a struct
field added to one crate and not yet handled in another, blocks every other person in the
repository until you finish.

If a change has to be in flight for a while, keep the *registration* uncommitted until the thing it
registers compiles, and say so when someone's build goes red.

The nastier version of this is a **partial commit**: `pub mod score;` committed without
`score.rs`, or a struct field set in one file and declared in another that stayed unstaged. It
builds perfectly on the machine that made it — the missing pieces are sitting right there in the
working tree — and is broken for everyone else and for CI. Before pushing, check that `git status`
shows no untracked `.rs` under a crate you just touched, and no unstaged edit to a file the
committed one now depends on.

## 3. Run nodes from a private copy of the build outputs

A running node holds `mesh/target/debug/` and `server/*/bin/` open, so nobody can rebuild while it
is up — including you. Copy the outputs elsewhere and point `--install-root` at them. See
`RUNNING.md`.

The same applies to anything else exclusive: `apps/stingstream/android/` is regenerated wholesale by
`expo prebuild --clean` for whichever variant ran last, so ask before taking it.

## 4. Commit your own paths, explicitly

`git add <paths>`, never `git add -A` or `git add .`. The tree is full of other people's
uncommitted work, and a broad add sweeps it into your commit — where it is not lost, but it is
attributed to you and lands at a moment its author did not choose.

**In a crate someone else is also editing, stage by explicit file path — never by directory** — and
then **read `git diff --cached --stat` and confirm every staged file is one you changed for this
commit.** Naming files rather than directories is not enough on its own: a *file* you edited may
also hold somebody else's half-finished change, and committing it publishes their work at the
moment they least expected it. This is not hypothetical. M3d's first commit staged
`stingstream-mesh/src/{lib.rs,db.rs,api.rs}` — three files it really had edited — and carried with
them M4's in-flight `pub mod score;` for a file that was still untracked, which broke `master` for
everyone until M4 pushed the other half. If a staged hunk is not yours, take the file out of the
index (`git restore --staged <file>` is a *write*; ask first) or wait for its author.

**Best of all, do not rely on the index.** The pathspec form commits exactly what you name and
leaves everything else staged where it was, whoever put it there:

```
git commit --only <paths> -m "..."      # or: git commit -m "..." -- <paths>
```

One invocation (below) closes the window between *your* add and *your* commit. It does not close
the one where somebody else staged files **before** your invocation began — those are already in
the index, and a plain `git commit` takes them however tightly you pair the two. That is how
commit 5da2090 carried four of M3d's files despite a single `git add … && git commit`. `--only`
does not depend on timing at all.

**Stage and commit in a single shell invocation** — `git add <explicit paths> && git commit -F -`
— never as two calls with thinking in between. The index is shared, so a separate add and commit is
not atomic *in either direction*: another agent's `git add` can put its files in your commit, and
its `git commit` can carry yours away into its own. Both happened on 2026-09-05, hours apart. One
invocation closes the window.

The same reasoning rules out every git command that rewrites the working tree — `checkout --`,
`restore`, `reset`, `stash`, `clean`. To undo your own edits, reverse them by hand.

## 5. The app is bun-only

`apps/stingstream` installs with `bun`, and only `bun`. Yarn's hoisting introduces a second copy of
`react-native-screens` that crashes the Android app at startup — a *runtime* failure that no
bundler or CI check catches short of launching the app. `package.json` enforces this with a
`preinstall` guard and a `packageManager` field; do not work around them. See `APP-DEV.md`.

## 6. A shell script authored on Windows has no executable bit until you give it one

Every checkout in this repo happens to be on Windows today, and Windows/NTFS has no POSIX
executable bit at all — a `.sh` file written or edited here lands in git as mode `100644`, and a
real Linux runner refuses to run it directly: `tools/package-node.sh: Permission denied` (exit
126), found breaking M8a's release workflow this way. Fixing the *content* is not enough; the mode
bit is a separate thing git tracks, and this checkout's `core.filemode=false` (set for a reason —
without it, ordinary Windows checkout noise across five vendored subtrees makes half the repository
look "modified" on every `git status`) means git does not even notice a plain `chmod +x` here.

```
git update-index --chmod=+x path/to/script.sh
git diff --cached --stat                      # confirm this shows ONLY the files you meant to touch
git commit -F -                               # a bare commit, not `--only`/`-- <paths>` -- see below
```

**`git commit --only <paths>` (rule 4's own recommendation) will silently discard this fix.** Its
pathspec form rescans the *working tree* for the named paths before snapshotting — correct and
exactly the point for ordinary content changes, but on this filesystem the working tree never
actually reports as executable (there is no on-disk bit for Windows to set), so the rescan resets
your index-only mode change back to `644` before the commit is made, and you get a clean-looking
"nothing to commit" with no error. The only way to actually commit a mode-only change here is a
bare `git commit` of the index as it stands — which is why the `git diff --cached --stat` check
above is not optional in this one case: a bare commit has none of `--only`'s protection against
sweeping in someone else's staged files, so you are the protection. Confirm the diff shows
exactly what you intended, and nothing else, before running it.

If a file's *content* also changed, commit that with the normal `--only` pathspec form first (rule
4), then do the mode-only fix above as its own, separate, bare commit.

## 7. Lint the files you touched, not the repository

`bun run check` (biome) reports **229 errors across the Streamyfin fork**, and has since M0. They
are upstream's formatting, not ours, and none of them is a bug. Two things follow, and the second is
the one that matters:

* **Do not run `bun run lint`, `bun run format` or `biome check --write` over the whole tree.** It
  rewrites hundreds of files nobody is working on, makes every future `git subtree pull` conflict on
  formatting, and — in a checkout several people share — sweeps other people's uncommitted work into
  a reformat they did not ask for.
* **Run it on your own paths**: `bunx biome check --write lib/stingstream/ components/stingstream/`
  or, more simply, on the files you changed. That is what the StingStream-owned code is held to.

**The repo-wide count is therefore expected to be non-zero**, and `bun run test` (which chains
`typecheck`, `test:unit`, `lint`, `format`, `i18n:check` and `doctor`) goes red because of it. The
gates that are actually enforced are `bun run typecheck`, `bun test` and `bun run i18n:check` — all
three are green and all three are what CI runs.

Fixing the 229 properly means reformatting the fork, which is a decision about upstream tracking
rather than about code quality: it would make every merge conflict for as long as we pull from
Streamyfin. Not worth it while we still pull. Revisit when we cut the cord (`ARCHITECTURE.md`,
"Fork depth").
