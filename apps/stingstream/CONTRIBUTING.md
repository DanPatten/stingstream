# Contributing to the StingStream app

Thanks for helping out. StingStream ships to phones, tablets and Android TV / Google TV from
one codebase, so a change that looks small usually has several places where it can go wrong.
This guide is about catching that before a reviewer has to.

This app is forked from [Streamyfin](https://github.com/streamyfin/streamyfin) — see the
Heritage note at the end.

## Before you start

- Search the repository's issues first. If one describes your problem, say so there before
  opening a PR, and link it later with `Fixes #123`.
- For anything larger than a bug fix, open an issue first. A design discussion after the code
  is written is a discussion nobody enjoys.
- Translations: add keys to `translations/en.json` only. Every other catalogue is regenerated
  by tooling and hand edits are overwritten — see [CLAUDE.md](CLAUDE.md)'s translations rule.

## Setup

1. Node `>20`.
2. [Bun](https://bun.sh). **The project uses bun exclusively.** Do not use npm, yarn or
   npx: the lockfile is `bun.lock` and CI checks it against `package.json`.
3. Xcode and/or Android Studio, following the
   [Expo guides](https://docs.expo.dev/workflow/android-studio-emulator/).
4. The [Biome](https://biomejs.dev) extension in your editor.

```bash
bun i && bun run submodule-reload
bun run prebuild          # bun run prebuild:tv for the TV variant
bun run ios               # or: bun run android, bun run ios:tv, bun run android:tv
```

If an iOS build fails with `missing Metal Toolchain`, run
`bun run ios:install-metal-toolchain` once.

## While you work

The conventions live next to the code they govern:

- [docs/conventions/constants.md](docs/conventions/constants.md): where a value belongs.
- [docs/conventions/contributing-flow.md](docs/conventions/contributing-flow.md): the
  operational checklist for branches, PRs and reviews.
- [docs/conventions/tv.md](docs/conventions/tv.md): everything specific to Android TV /
  Google TV, including the focus rules that are easy to break without noticing.
- [CLAUDE.md](CLAUDE.md): the architecture map, the provider stack and the patterns to
  follow. It is written for AI assistants but it is the fastest orientation for a human
  too.
- [../../docs/CONTRIBUTING.md](../../docs/CONTRIBUTING.md): the monorepo's shared-checkout
  rules (this repository is worked on by several people and agents at once).

Two rules catch most review comments before they are written:

- **Use `useAppRouter`**, not `useRouter` from `expo-router`, so offline mode survives
  navigation.
- **Never rely on the `.tv.tsx` suffix resolving on its own.** It only does under
  `EXPO_TV=1`. Branch on `Platform.isTV` and require the TV file explicitly.

## Before you open a pull request

```bash
bun run typecheck
bun test
bun run i18n:check
```

Those three are the gates CI actually enforces. `bun run test` also chains lint, format and
Expo Doctor; the fork carries pre-existing formatting differences from upstream that are not
worth fixing while it still tracks Streamyfin (see
[../../docs/CONTRIBUTING.md](../../docs/CONTRIBUTING.md)), so lint/format on the whole tree is
expected to be non-zero — run Biome on the files you touched instead:
`bunx biome check --write <your files>`.

Then make sure the change carries its own proof:

- A bug fix has a test that fails on the reported behaviour and passes with the fix.
- A new shared or tunable value lives in `constants/`.
- A behaviour change that is not purely visual reaches phone and TV in the same PR.
- New UI strings exist in `translations/en.json` and nowhere else.
- No user-visible text names Jellyfin, Streamyfin, Radarr, Sonarr, NZBGet or Emby — see
  `brand.test.ts`.
- [CLAUDE.md](CLAUDE.md) still matches the code. It is the map everyone reads first, human
  or assistant, so a new tab group, native module, provider or top-level directory goes in
  it as part of the same PR.

## Pull requests

- The PR title follows [Conventional Commits](https://www.conventionalcommits.org), for
  example `fix(player): keep the resume point when exiting`. CI validates it.
- UI changes ship before and after screenshots for phone and Android.
- Testing instructions are numbered steps a reviewer can follow without asking you a
  question.

### Testing on real devices

A simulator proves the code path runs. It does not prove hardware behaviour: volume
buttons, background playback, network loss, Chromecast, TV remotes. Test those on a device
before claiming they work.

For playback and reporting changes, the server log is the ground truth. Run the scenario,
then read what the server recorded.

## License

By contributing you agree that your contribution is licensed under the
[MPL-2.0](LICENSE.txt), like the rest of this app.

## Heritage

This app began as a fork of [Streamyfin](https://github.com/streamyfin/streamyfin), an
open-source Jellyfin client, and its early history and many patterns still owe a debt to that
project and its contributors. StingStream is its own project from here: this file, its
user-facing copy and its issue tracker are about this repository, not upstream's.
