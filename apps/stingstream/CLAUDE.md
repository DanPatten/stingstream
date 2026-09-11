# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

This file is an index, not a manual. When a topic below points at a document, read that
document before relying on assumptions: most of these rules exist because their absence
already broke something, and the reason is written down where the rule lives.

## Keeping this file true

This file is loaded into context on every session, so a stale line in it is not a missing
answer, it is a confident wrong one. When a change makes something here inaccurate, or
adds something worth knowing, update it in the same PR. The triggers:

- a tab group, route group or top-level directory added or removed
- a native module added or removed
- a provider added to the stack in `app/_layout.tsx`, or moved within it
- an SDK, runtime or major dependency bump that dates the stack section
- a new convention worth writing down: it goes to `docs/conventions/` with a row in the
  table below
- a fact that cost you an afternoon to find: it goes to `.claude/learned-facts/` with a
  line in the index

`CLAUDE.test.ts` pins the native module list, the tab groups and the convention index in
both directions, so drift in those fails the suite instead of surviving for months.
Everything else depends on you noticing.

## Conventions

Read the relevant one before writing code in that area.

| Document | Read it when |
| --- | --- |
| [docs/conventions/constants.md](docs/conventions/constants.md) | Adding a threshold, interval, ratio, storage key, or any value used twice |
| [docs/conventions/contributing-flow.md](docs/conventions/contributing-flow.md) | Opening, describing, or reviewing a PR |
| [docs/conventions/tv.md](docs/conventions/tv.md) | Touching anything that renders on Apple TV or Android TV |

Deep dives: [tv-modal-guide.md](docs/tv-modal-guide.md),
[tv-focus-guide.md](docs/tv-focus-guide.md), [tv-discovery.md](docs/tv-discovery.md),
[nested-modals.md](docs/nested-modals.md).

## Learned facts

One file per hard won fact in `.claude/learned-facts/`. Read the relevant one before
debugging in that area.

Navigation:
- `native-bottom-tabs-userouter-conflict` | useRouter() at provider level causes tab switches; use static router import
- `introsheet-rendering-location` | IntroSheet in IntroSheetProvider affects native bottom tabs via nav state hooks
- `intro-modal-trigger-location` | Trigger in Home.tsx, not tabs _layout.tsx

UI and headers:
- `macos-header-buttons-fix` | macOS Catalyst: use RNGH Pressable, not RN TouchableOpacity
- `header-button-locations` | Defined in _layout.tsx, HeaderBackButton, Chromecast, RoundButton, etc.
- `stack-screen-header-configuration` | Sub-pages need explicit Stack.Screen with headerTransparent + back button
- `switch-pointerevents-ignored` | Switch ignores its own pointerEvents (Android); wrap in a View pointerEvents="none"
- `pressable-listitem-cannot-hold-buttons` | A pressable ListItem is a real `<button>` on web; row action buttons must be siblings, not `iconAfter`
- `no-browser-dialogs` | Never `globalThis.confirm`/`alert`; `Alert.alert` draws nothing on web and is TV-only. Use `confirmDestructive`/`confirmAction`/`toast`

State and data:
- `use-network-aware-query-client-limitations` | Object.create breaks private fields; only for invalidateQueries
- `mark-as-played-flow` | PlayedStatus -> useMarkAsPlayed -> playbackManager with optimistic updates

Native modules:
- `expo-view-props-fail-silently` | `try? prop.set()` drops failed prop conversions with NO error; use a JSON string prop
- `mpv-tvos-player-exit-freeze` | mpv_terminate_destroy deadlocks main thread; use DispatchQueue.global()
- `mpv-avfoundation-composite-osd-ordering` | MUST follow vo=avfoundation, before hwdec options
- `thread-safe-state-for-stop-flags` | Stop flags need synchronous setter (stateQueue.sync not async)
- `native-swiftui-view-sizing` | Need explicit frame + intrinsicContentSize override in ExpoView

TV platform:
- `tv-modals-must-use-navigation-pattern` | Use atom+router.push(), never overlay/absolute modals
- `tv-grid-layout-pattern` | ScrollView+flexWrap, not FlatList numColumns
- `tv-horizontal-padding-standard` | TV_HORIZONTAL_PADDING=60, not old TV_SCALE_PADDING=20
- `streamystats-components-location` | components/home/Streamystats*.tv.tsx, watchlists/[watchlistId].tsx
- `platform-specific-file-suffix-does-not-work` | .tv.* only resolves under EXPO_TV=1; require the TV file explicitly behind Platform.isTV

Build and tooling:
- `eas-archive-drops-gitignored-tracked-files` | EAS uploads skip anything matching .gitignore even if tracked; re-include required assets, keep asset require() at module scope
- `bun-test-discovery-leaks-fds` | bare `bun test` leaves ~14k fds open; child processes spawned from tests get dead stdio, so do the work in-process

## Project overview

Streamyfin is a cross platform Jellyfin client built with Expo and React Native. It runs
on iOS, Android, Apple TV and Android TV, with offline downloads, Chromecast and
Jellyseerr integration.

## Commands

**Always use `bun`. Never `npm`, `yarn` or `npx`.**

```bash
# Setup
bun i && bun run submodule-reload

# Mobile
bun run prebuild
bun run ios
bun run android

# TV (same commands, :tv suffix)
bun run prebuild:tv
bun run ios:tv
bun run android:tv

# Quality
bun run typecheck            # TypeScript
bun run check                # Biome, read only
bun run lint                 # Biome with fixes
bun run format               # Biome formatter
bun run test:unit            # Unit tests
bun run test                 # The full gate: typecheck, unit, lint, format, i18n, doctor

# iOS specific
bun run ios:install-metal-toolchain   # Fixes "missing Metal Toolchain" build errors
```

## Stack

- **Runtime and package manager**: Bun
- **Framework**: Expo SDK 57, React 19, `react-native-tvos`
- **Language**: TypeScript, strict mode
- **State**: Jotai for global state, React Query for server state
- **API**: Jellyfin SDK (`@jellyfin/sdk`)
- **Navigation**: Expo Router, file based
- **Lint and format**: Biome
- **Storage**: `react-native-mmkv`

## Repository layout

| Path | Holds |
| --- | --- |
| `app/` | Expo Router screens, file based routing |
| `components/` | Reusable UI |
| `providers/` | React context providers |
| `hooks/` | Custom hooks |
| `utils/` | Utilities, including the Jotai atoms in `utils/atoms/` |
| `constants/` | Shared and tunable values, see the constants convention |
| `modules/` | Local native modules |
| `services/` | Long lived services (playback) |
| `packages/` | Local shims resolved by Metro |
| `targets/` | Extra native targets (top shelf, download activity) |
| `plugins/` | Expo config plugins |
| `patches/` | Patch package overrides |
| `augmentations/` | Type augmentations |
| `test-utils/` | Shared test doubles: Jellyfin API, MMKV, custom headers, React Native |
| `translations/` | i18n catalogues, `en.json` is the only source |
| `scripts/` | Repo tooling run through bun |
| `docs/` | Conventions and deep dives |

## Key patterns

**State**
- Global state is Jotai atoms in `utils/atoms/`.
- `settingsAtom` in `utils/atoms/settings.ts` holds app settings. A new setting must also
  be toggleable in the settings UI, mobile or TV depending on its scope, or it is dead.
- `apiAtom` and `userAtom` in `providers/JellyfinProvider.tsx` hold auth state.
- Server state goes through React Query.

**Jellyfin API**
- Authenticated calls use `apiAtom`, the current user comes from `userAtom`.
- Prefer the SDK helpers from `@jellyfin/sdk/lib/utils/api` over hand rolled requests.

**Navigation**
- File based routing under `app/`.
- Tab groups: `(home)`, `(search)`, `(favorites)`, `(libraries)`, `(watchlists)`,
  `(custom-links)`, `(settings)`, `(downloads)`, `(requests)`. `(downloads)` is
  administrator-only and hidden on TV; `(requests)` is visible to every member and present
  on TV, with its elevated sections (Approvals, Activity, Policy) dropped there. Routes
  shared by several tabs live in the combined group
  `(home,libraries,search,favorites,watchlists)`.
- There is no `(manage)` group, and no arr library screen either. Both were folded into
  the things they were about: the arr queue, history and calendar are Requests → Activity,
  adding a title is Requests → Find, and what this server does about one title it already
  tracks — monitoring, quality profile, remove with or without files — is the overflow menu
  on that title's own page (`components/stingstream/arr/ManageTitleSheet.tsx`, offered only
  when `useArrTitle` finds a row, so a title held by another node offers nothing), and the
  same sheet on its request row (`arr/ManageTitleAction.tsx`) for the window before a file
  lands and the title has a page at all. Its components live in
  `components/stingstream/arr/`.
- There is no Downloading page either. Whether this node fetches a kind of title is a
  library's own switch, on Settings → Libraries
  (`components/stingstream/settings/LibrariesSection.tsx` over `lib/stingstream/libraries.ts`),
  beside the folder that library writes to: turning Movies on is what starts the movie
  manager. One endpoint writes both halves, so they cannot drift. Usenet is not about a
  library and lives under Indexers & engines.
- **IMPORTANT**: use `useAppRouter` from `@/hooks/useAppRouter`, never `useRouter` or the
  static `router` from `expo-router`. The wrapper preserves offline mode across
  navigation.

  ```typescript
  // Correct
  import useRouter from "@/hooks/useAppRouter";
  const router = useRouter();

  // Never
  import { useRouter } from "expo-router";
  ```

**Offline mode**
- Wrap pages that serve downloaded content in `OfflineModeProvider` from
  `@/providers/OfflineModeProvider`.
- `useOfflineMode()` reports whether the current context is offline.
- `useAppRouter` injects `offline=true` when navigating inside an offline context.

**Provider stack** (`app/_layout.tsx`, outermost first). The order is load bearing: each
provider below depends on the ones above it.

```text
PersistQueryClientProvider
  JellyfinProvider          auth, api
    InactivityProvider
      WifiSsidProvider
        ServerUrlProvider
          NetworkStatusProvider
            PlaySettingsProvider
              LogProvider
                WebSocketProvider
                  DownloadProvider
                    NativePlayerProvider
                      MusicPlayerProvider
                        GlobalModalProvider
                          BottomSheetModalProvider
                            IntroSheetProvider
                              ThemeProvider
```

`JotaiProvider` and `ActionSheetProvider` wrap the tree higher up, at the root layout.

**Native modules** in `modules/`: `mpv-player` (the native player, iOS and Android),
`exoplayer-player`, `background-downloader`, `glass-poster`, `hero-carousel`,
`stingstream-mesh` (the embedded mesh light node, Android and Android TV — see
`docs/APP-MESH.md`), `system-volume`, `top-shelf-cache`, `tv-recommendations`, `tv-search`,
`tv-user-profile`, `wifi-ssid`.

**Path aliases**: `@/` maps to the repo root.

```typescript
import { useSettings } from "@/utils/atoms/settings";
import { apiAtom } from "@/providers/JellyfinProvider";
```

## Coding standards

- TypeScript everywhere. The only exceptions are the config files whose loaders cannot
  parse TypeScript: `babel.config.js`, `metro.config.js`, `react-native.config.js`,
  `tailwind.config.js`.
- Functional components with hooks.
- Biome formatting: two space indent, semicolons, LF endings.
- Reuse the existing atoms, hooks and utilities before adding new ones.
- Comments explain why, not what. Reach for one at a hook, an early return, or a
  non obvious decision, and leave the obvious lines alone.
- Shared or tunable values go to `constants/`. See
  [docs/conventions/constants.md](docs/conventions/constants.md).
- Behaviour changes come with tests. A bug fix starts with a test that fails on the
  reported behaviour.
- **Translations**: add keys to `translations/en.json` only. Every other catalogue is
  generated by Crowdin and hand edits are overwritten. Check for an existing key first,
  and keep one key per whole sentence instead of assembling sentences from fragments.
- **StingStream is one app, and copy must never say otherwise.** No user-facing string
  names Radarr, Sonarr, NZBGet or Jellyfin, and none describes them as separate things
  the reader has to keep in step: no "both apps", no "the two apps disagree", no "Create
  in both apps", no "the movie manager and the series manager". Say what the node did
  ("Saved", "Synced"), not which child did it. The rule covers `translations/en.json`,
  toasts, empty states, labels, dialogs and any error that reaches a screen; it does not
  cover code, comments, logs or `docs/**`, where the real child names stay. Full rule and
  the why: the root [`CLAUDE.md`](../../CLAUDE.md), "StingStream is one app".
- **Server images**: import `Image` from `@/components/common/ServerImage` rather than
  `expo-image`. It is a pass-through today — it used to attach the custom proxy auth
  headers, which are gone — and is kept as one name so there is a single place to change
  if server images ever need special handling again.
- **Settings save themselves. No Save button.** A settings pane drafts with
  `components/stingstream/settings/useAutosave.ts`: a switch is sent the moment it is flipped
  (`{ now: true }`), a field a second after the last keystroke, and whatever is still pending is
  flushed when the screen unmounts. `SaveStatus` says a change is in flight; the outcome is a
  toast, bottom right. The exceptions are the two places a click really is the decision: a
  password change, and a dialog that creates something. Dan: *"no save buttons in settings please
  unless its SUPER critical change, but for 95% no save - changes are auto applied"*.
- **One text field.** Everything typed into goes through `@/components/common/Input`, which owns
  the box, the hover tint and the focused border. A settings row uses `TextFieldRow`, which wraps
  it. A bare `TextInput` reads as a printed value rather than a control, which is the bug this
  rule exists to stop. The sheets are the one exception, since `SheetTextInput` is what keeps the
  keyboard and the sheet in step.
- **One modal surface.** Anything that opens over the page is a `SheetModal` from
  `@/components/common/Sheet`, or goes through `showModal()`, which is the same component. It is a
  bottom sheet on a device and a centred card in a browser, so a screen never has to know which.
  Never import `@gorhom/bottom-sheet` in a screen or a component: its scrollables throw outside a
  sheet, so a `BottomSheetScrollView` that reaches the web card is a blank page rather than a
  layout nit. Use `SheetView`, `SheetScrollView`, `SheetFlatList` and `SheetTextInput`.
  `components/common/oneModalSurface.test.ts` fails on a stray import.
- **Three themes, and every colour comes from the active one.** `dark`, `light` and `sting` are all
  shipping, and a screen is not finished until it has been looked at in all three. Read colours
  from `useTheme()` — `color.bg`, `color.text`, `color.border`, `accent` — never from a hex
  literal, never from the static `tokens.color`, which is the default palette frozen at import and
  ignores whatever the reader chose. The traps, all of them real:
  - **Selected means the accent.** `accent[500]` filled, with `accent.onAccent` for the text on top
    of it, is what `FilterChip` and the primary `Button` already do. Anything else has to be read
    twice: near-white said *unselected* in dark, because white is that palette's neutral, and a
    low-alpha accent tint was a dark smudge on a dark sheet and near-white on a light one.
  - **`onAccent` is not white.** It is `#04202A` on dark, `#FFFFFF` on light, `#16082E` on sting.
    Hard-coding white puts invisible text on the cyan and lilac accents.
  - **`border.subtle` is 8–12% and disappears** on a surface one step up from the page. A control
    that needs a visible edge in all three themes wants `border.strong`.
  - **The scrim, the elevation and the accent ring differ per theme too.** If it is a colour, it is
    in the palette; if it is not in the palette, it is probably a bug.
- **A focus ring is drawn inside the control, never outside it.** `webFocusRing` sets a negative
  `outline-offset`, and `public/index.html` does the same for anything still falling back to the
  browser's own outline. It used to sit 2px outside, which is the prettier place for it and the
  wrong one: a CSS outline is painted outside the border box, so every ancestor that clips cut it
  off. A horizontal `ScrollView` is `overflow-y: hidden` on web, so every chip bar and tab strip
  sheared the ring flat along the top; a rounded card with `overflow: hidden` swallowed it whole.
  445 controls were clipped, measured across the app at two viewports. Padding the containers was
  the old rule and it did not hold — it is four pixels every new scroller, sheet and card has to
  remember. **Do not reintroduce an outside ring, and do not add padding for one.**
  - **A filled control passes `ringColor`.** Drawn inside, an accent ring on an accent fill is
    invisible. Pass the colour the control's own label already uses — `accent.onAccent` on a
    `FilterChip`, `Fill.ring` on a `Button` — through `usePressableStates({ ringColor })` or as
    `webFocusRing`'s third argument.
  - **Measure it** — `getBoundingClientRect()` on the control against the nearest ancestor whose
    `overflow` is not `visible` — rather than judging it from a screenshot.
- Conventional Commits for commits and PR titles: `feat(scope):`, `fix(scope):`,
  `chore(scope):`. CI validates the PR title.

## Platform notes

- Platform checks: `Platform.isTV`, `Platform.OS === "android" | "ios"`.
- TV builds use the `:tv` script suffix.
- Some features are off on TV, notifications and Chromecast among them.
- The rest of the TV rules, covering focus, modals, typography and lists, live in
  [docs/conventions/tv.md](docs/conventions/tv.md). Read it before touching TV code.
