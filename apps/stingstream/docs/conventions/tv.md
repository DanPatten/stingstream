# TV platform conventions

Rules that only apply when the app runs on Apple TV or Android TV. Everything here
was learned the hard way: each rule exists because its absence broke something.

Related deep dives: [tv-modal-guide.md](../tv-modal-guide.md),
[tv-focus-guide.md](../tv-focus-guide.md), [tv-discovery.md](../tv-discovery.md).

## Platform-specific files

Metro is configured to resolve a `.tv.*` extension first, but only when `EXPO_TV=1`
(`metro.config.js`). The codebase deliberately does not rely on that resolution, because
it silently disappears in any build where the variable is not set. Pick the TV variant
explicitly instead.

For a page, branch at the top and return the TV component:

```typescript
// app/login.tsx
import { Platform } from "react-native";
import { Login } from "@/components/login/Login";
import { TVLogin } from "@/components/login/TVLogin";

const LoginPage: React.FC = () => {
  if (Platform.isTV) {
    return <TVLogin />;
  }
  return <Login />;
};

export default LoginPage;
```

For a component, keep the mobile and TV implementations in separate files and require the
TV one behind the same check, the way `components/ItemContent.tsx` does:

```typescript
const ItemContentTV = Platform.isTV
  ? require("./ItemContent.tv").ItemContentTV
  : null;
```

Both naming styles exist in the tree, `MyComponent.tv.tsx` and `TVMyComponent.tsx`. The
suffix is a label, not a resolution mechanism: whichever you pick, the import stays
explicit. TV components use the `TV`-prefixed building blocks (`TVInput`, `TVServerCard`
and friends) which carry the focus handling.

## Design

- No purple accent on TV. Focused states are white, backgrounds and overlays use
  `expo-blur` (`BlurView`).
- Buttons sitting next to each other must have the same size. Uneven neighbours read as
  a rendering bug on a 10 foot screen. `TVButton` takes a `minHeight` for exactly this:
  give every button in one row the same value and the row reads as one control strip.

## Card geometry

Every focusable card on a television is one of five shapes, and they live in
`constants/TVCardLayouts.ts`: `portrait` (movies and series), `wide` (landscape
artwork), `episode`, `hero` (the spotlight strip) and `rail` (square tiles). Ask
for a shape, do not invent one:

```typescript
const card = useScaledTVCardLayout("portrait");
<View style={{ width: card.cardWidth, aspectRatio: card.aspectRatio, borderRadius: card.borderRadius }} />
```

A skeleton uses the same call as the row it stands in for. A placeholder half a
poster narrower than the content that replaces it makes every row jump when the
query resolves, which is the single most visible loading defect on this surface.

`TV_FOCUS` in the same file is the one focus treatment: scale 1.05 over 150 ms,
a 2 px white border, a 30% white glow at radius 12. `useTVFocusAnimation`
defaults to it, so a component that wants the standard behaviour passes nothing.
`tvCardFocusOverflow(layout)` says how far a focused card grows past its own box
on each side, and `tvCardRowHeight(layout, textHeight)` budgets a row for it.

## The navigation rail, and the one content inset

Navigation is `components/tv/TVNavRail.tsx`: an absolute overlay on the left
edge, 96 wide at rest and 288 once anything inside it takes focus. Because it is
an overlay, screens do not lose layout width to it — they owe it a left inset,
and that inset is one constant, `TVLayout.contentInsetLeft` (`constants/TVSizes.ts`).

Every TV screen starts its content at `sizes.layout.contentInsetLeft` on the
left, pads by `sizes.padding.horizontal` on the right, and uses
`sizes.layout.contentInsetTop` at the top. There is no top bar to reserve space
for any more, so the old 100–145 px allowances are gone. Nothing focusable may
sit left of the inset, or the collapsed rail covers it.

Focus rules the rail depends on, all of them load bearing:

- **No rail item carries `hasTVPreferredFocus`.** Content keeps the initial
  focus on every screen, so the rail is somewhere you go, not somewhere you land.
- The rail column is wrapped in `TVFocusGuideView trapFocusUp trapFocusDown`.
  Without the traps, UP from the first item escapes into whatever content is
  painted behind the rail.
- LEFT and RIGHT are deliberately **not** trapped: LEFT from the leftmost content
  column reaches the rail geometrically, and RIGHT goes back the same way.
- A rail row's focusable box is the *collapsed* width, with the label as an
  absolutely positioned sibling that overflows it. Android TV's focus search uses
  layout bounds, so a row laid out at the expanded width keeps a 288 px focus
  rectangle while looking 96 px wide, and RIGHT out of the rail lands back inside
  the rail.

## Image budget

`constants/TVImageBudget.ts` is what the TV build may spend on images, and
`app/_layout.tsx` configures expo-image from it. Two rules follow from it:

- Ask the server for the size you render, times `posterDecodeMultiplier`. A flat
  `fillHeight=700` for a 250 px card decodes eight times the pixels you can show.
- **Anything whose decoded size crosses `diskOnlyAboveBytes` (1 MiB) must use
  `cachePolicy="disk"`.** Backdrops, the hero image and logos are all above the
  line; posters are not. `tvCachePolicyForSize(width, height)` answers it for you.
  A 1920-wide backdrop is ~8 MB of decoded ARGB — a handful of them pinned in the
  memory cache is the whole 24 MiB budget, and then the system kills the app
  mid-playback.

Acceptance measures this: `dumpsys meminfo org.stingstream.app` PSS must grow by
less than 40 MB after scrolling five rows. `scripts/tv-walk.ts --meminfo` records
it either side of a D-pad walk.

## Typography

Size TV text from `@/constants/TVTypography`. It is not a component: call the
`useScaledTVTypography()` hook and apply the returned sizes (`typography.callout` and
friends) to the shared `Text` component, the way `components/tv/TVPosterCard.tsx` does.
Never hardcode font sizes on TV.

## Spacing and focus scale

Horizontal padding is `TV_HORIZONTAL_PADDING = 60` (the old `TV_SCALE_PADDING = 20` is
gone).

Focusable items in tables, rows, columns and lists need room around them: the focus
animation scales roughly 1.05x and clips against a tight parent. Use
`overflow: "visible"` on containers and pad enough that the scaled item still fits.

## Modals

Never use React Native's `Modal` component, nor an overlay or absolutely positioned view,
for a full screen modal on TV. Use the navigation based pattern: a Jotai atom plus
`router.push()`. See [tv-modal-guide.md](../tv-modal-guide.md) for the full pattern,
including dropdowns, bottom sheets and overlay focus management.

## Lists and focus flicker between zones

A page with several focusable zones (a filter bar above a grid, for instance) can make
the TV focus engine flicker rapidly between elements. This is a known React Native TV
issue. Four rules keep it away:

1. **Use `FlatList`, not `FlashList`.** FlashList has known focus problems on TV.

   ```typescript
   {Platform.isTV ? (
     <FlatList data={items} renderItem={renderTVItem} removeClippedSubviews={false} />
   ) : (
     <FlashList data={items} renderItem={renderItem} />
   )}
   ```

2. **Set `removeClippedSubviews={false}`.** Otherwise off screen items unmount and focus
   falls through to unrelated elements.
3. **Exactly one element gets `hasTVPreferredFocus`.** Two elements competing for the
   initial focus is the flicker. Usually the first filter button, not a list item —
   and never a navigation rail row. Grep the screen before you ship it.
4. **Keep the header or filter bar outside the list.** Render it as a sibling `View`
   above the `FlatList` rather than as `ListHeaderComponent`, and do not wrap it in a
   `ScrollView`: two scrollable containers fight over focus.

Reference implementation: `app/(auth)/(tabs)/(libraries)/[libraryId].tsx`.

## Focus guides for non adjacent sections

When focus has to travel between sections that are not geometrically aligned (left
aligned buttons to a horizontal `ScrollView`, say), use `TVFocusGuideView` with
`destinations`:

```typescript
// 1. Track the destination with useState, NOT useRef: a ref never re-renders.
const [firstCardRef, setFirstCardRef] = useState<View | null>(null);

// 2. Place the invisible guide between the two sections.
{firstCardRef && (
  <TVFocusGuideView destinations={[firstCardRef]} style={{ height: 1, width: "100%" }} />
)}

// 3. The target component forwards its ref.
const MyCard = React.forwardRef<View, Props>((props, ref) => (
  <Pressable ref={ref} {...props} />
));

// 4. The state setter is the callback ref of the first item.
{items.map((item, index) => (
  <MyCard ref={index === 0 ? setFirstCardRef : undefined} />
))}
```

Bidirectional navigation and the rest of the API live in
[tv-focus-guide.md](../tv-focus-guide.md). Reference implementation:
`components/ItemContent.tv.tsx`.

## Walking a screen with the D-pad

`scripts/tv-walk.ts` replays a key sequence over `adb shell input keyevent` and
captures the framebuffer after each press, which is the only way to check focus:
there is no DOM to query and no accessibility tree worth reading over adb.

```bash
bun scripts/tv-walk.ts --flow tools/ui-shots/tv-flow.json \
  --out .win-temp/ui-loop/<package>/shots/pass-01 --meminfo --logcat
```

A flow file is `[{ screen, keys, settleMs?, note? }]`; one PNG per key press,
named so the sequence reads in file order and a regression is a diff of two
directories. `--meminfo` brackets the run with `dumpsys meminfo`, `--logcat`
dumps `adb logcat -d *:E` and reports any `ReactNativeJS` lines.

What a walk has to show before a TV change ships: every screen reachable and
exitable by D-pad alone, exactly one focused element per capture, LEFT from
column 0 opening the rail and RIGHT returning to content, no text below callout
size, adjacent buttons of equal height, and no purple anywhere.

## Parity with mobile

A fix that is not purely visual applies to both phone and TV. When you change playback,
reporting, settings resolution or any other shared behaviour, carry it to the TV surface
in the same PR, and say so in the description.
