# StingStream app

This is the client app for [StingStream](../../README.md): the phone, tablet, web and TV
interface that talks to a StingStream node's gateway. One Expo/React Native codebase builds
for Android, Android TV / Google TV, web and (buildable, not yet shipped) iOS.

Forked from [Streamyfin](https://github.com/streamyfin/streamyfin) (see this app's
[CONTRIBUTING.md](CONTRIBUTING.md) for what that heritage does and does not mean for this fork).

## Building

The project uses [Bun](https://bun.sh) exclusively. Do not use `npm`, `yarn` or `npx`.

```bash
bun i && bun run submodule-reload
bun run prebuild          # bun run prebuild:tv for the TV variant
bun run ios               # or: bun run android, bun run ios:tv, bun run android:tv
```

If an iOS build fails with `missing Metal Toolchain`, run
`bun run ios:install-metal-toolchain` once.

Quality gates:

```bash
bun run typecheck
bun test
bun run i18n:check
bun run test               # the full gate: typecheck, unit tests, lint, format, i18n, doctor
```

## Learn more

- [../../docs/APP-DEV.md](../../docs/APP-DEV.md) — running against a local node, TV emulator
  workflow, Metro/dev-client setup.
- [../../docs/APP-MESH.md](../../docs/APP-MESH.md) — the embedded mesh light node.
- [CLAUDE.md](CLAUDE.md) — architecture map, provider stack, coding conventions.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [../../docs/CONTRIBUTING.md](../../docs/CONTRIBUTING.md)
  — this app's process, and the monorepo's shared-checkout rules.
