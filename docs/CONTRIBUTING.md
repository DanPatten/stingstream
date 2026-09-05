# Working in this repository

Five conventions, each of which exists because ignoring it cost someone real time. The rest of the
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

The same reasoning rules out every git command that rewrites the working tree — `checkout --`,
`restore`, `reset`, `stash`, `clean`. To undo your own edits, reverse them by hand.

## 5. The app is bun-only

`apps/stingstream` installs with `bun`, and only `bun`. Yarn's hoisting introduces a second copy of
`react-native-screens` that crashes the Android app at startup — a *runtime* failure that no
bundler or CI check catches short of launching the app. `package.json` enforces this with a
`preinstall` guard and a `packageManager` field; do not work around them. See `APP-DEV.md`.
