# StingStream design system

How the app looks and how it answers a pointer, a key and a remote control.
Companion to `docs/UI.md` (how a screen is wired to data) and
`apps/stingstream/docs/conventions/tv.md` (the 10-foot rules, which override
anything here on a television).

The source of truth is `apps/stingstream/constants/theme.tokens.json`. Two
things read it and nothing else may: `tailwind.config.js`, which turns it into
utility classes, and `constants/theme.ts`, which turns it into typed values for
inline styles. A hex, a radius, a font size or a shadow written anywhere else is
a bug — it is how the fork ended up with nine colours in `Colors.ts` and inline
hexes in a hundred files.

**NativeWind v2 compiles Tailwind once, at build time, and has no CSS
variables.** So a class can only ever carry the *default* accent (teal, the
brand colour). Anything that must follow the accent a user picked in Appearance
reads `useTheme().accent` and sets it inline. Both are correct in their place:
brand furniture stays teal, user-accented furniture reads the hook. Token edits
do not survive Metro's cache — restart with `-c`.

---

## Interaction states

Every interactive surface answers the same four states, and they come from
`hooks/usePressableStates.ts` rather than from each component's own `useState`.
Before it existed, a mouse crossing the page lit up some things and not others —
the button had hover but no pressed tint, list rows had hover and nothing else,
and cards had neither — which reads as half the interface being decoration.

```tsx
const states = usePressableStates({ disabled });

<Pressable {...states.handlers} disabled={disabled} style={[box, states.webStyle]}>
```

| State | What it is | How it is drawn |
|---|---|---|
| **rest** | nothing is happening | the control's own surface |
| **hovered** | a pointer is over it (web only in practice) | white at 6 % over the surface, or one step up the surface scale |
| **pressed** | a finger or button is down on it | white at 10 %, or two steps up |
| **focused** | it has keyboard focus | a 2 px accent-400 outline, offset 2, **web only** |
| **disabled** | it cannot be actuated | fill at 35 %, label at 60 %; `cursor: not-allowed` |

Two rules are baked into the hook rather than left to each caller:

- **Disabled outranks everything.** A `Pressable` with `disabled` set stops
  firing press events but keeps firing hover ones on web, so without the
  precedence a disabled button still lit up under the cursor.
- **Pressed outranks hovered**, because a phone browser fires `onHoverIn` from a
  tap and the pill would otherwise stick in its hover tint after the finger
  lifted.

### Disabled is two alphas, not one opacity

A disabled *filled* control fades its fill to 35 % and its label to 60 %
(`interaction.disabledFillAlpha` / `disabledLabelAlpha`), rather than putting a
single `opacity` on the whole control. A uniform fade leaves a fully legible
label floating on an almost-invisible fill, which reads as a link rather than as
a switched-off button. Keeping the label the more solid of the two keeps the
shape of a button while saying clearly that it will not respond.

Rows and other *surfaces* — where there is no fill to fade — still use the
single `control.disabledOpacity`.

### Focus rings are web-only

`webFocusRing()` returns `outlineWidth` / `outlineColor` / `outlineOffset`,
which react-native-web maps onto a real CSS outline: the only focus indicator
that does not shift layout. Those three are not valid React Native style
properties, so the `Platform.OS === "web"` check lives at the call site (in the
hook), and `constants/theme.ts` stays free of any runtime react-native import so
plain `bun test` specs can read it.

**Never draw the accent ring on TV.** A television's focus is the white ring and
1.05 scale in `docs/conventions/tv.md`; the accent there competes with meaning.

### Per-component

| Component | rest | hovered | pressed | focused | disabled |
|---|---|---|---|---|---|
| `Button` primary | accent-500 | accent-400 | accent-600 | accent ring | accent-500 at 35 %, on-accent at 60 % |
| `Button` secondary | bg2 | bg3 | bg3 | accent ring | same rule on its own fill |
| `Button` ghost | transparent | white 6 % | white 10 % | accent ring | label at 60 % |
| `Button` danger | danger | danger 85 % | danger 75 % | accent ring | same rule |
| `Input` | subtle rule on bg2 | strong rule on bg3 | — | **accent-400 rule**, not a ring | `control.disabledOpacity`, `cursor: not-allowed` |
| `ListItem` (pressable) | bg1 | bg2 | bg3 | accent ring | `control.disabledOpacity`, no tint |
| `Pill` with `onPress` | its tone's fill | + white 6 % | + white 10 % | accent ring | fill and label faded |
| `Switch` | track bg3 | — | — | platform default | track accent at 35 % |
| Cards | artwork | scale 1.03 + e1 | — | accent ring | — |

`Input` is the deliberate exception: the rule around the field *is* the focus
affordance. An outline ring would sit outside the rounded rule and read as a
second border. Its precedence is `error > focused > hovered > rest`, because an
invalid field must stay red while it is being corrected — which is exactly when
it is also focused.

A `ListItem` with no `onPress` never changes colour. The whole point of the
tints is to say "this does something", and a settings row that only holds a
switch does not.

---

## Loading

**Skeletons for content, spinners only for a pending action.** A spinner says
"something is happening". A skeleton of the final geometry says *what* is about
to happen, holds the layout so nothing jumps when the data lands, and makes a
slow screen feel like it is filling rather than stalling.

```tsx
if (isLoading) return <SkeletonRow kind="portrait" count={6} withLabels />;
```

`components/common/Skeleton.tsx` has `Skeleton` (one block),
`SkeletonRow` and `SkeletonGrid` (card geometry straight from
`components/cards/CardData.ts`, so the placeholder and the real card can never
drift), and `SkeletonText` (a paragraph, last line short).

The pulse is opacity rather than a travelling highlight: a moving gradient needs
a masked layer per block, and on a grid of thirty cards that is thirty extra
animated views for an effect nobody looks at directly. It holds still when the
platform reports reduced motion — which is also how the screenshot sweep gets
two identical runs of the same screen.

`components/Loader.tsx` follows the user's accent (it was Streamyfin's purple on
every platform but iOS, which is why a violet ring kept appearing in a teal app)
and takes a `tone`, so a spinner inside a filled button can be drawn in the
button's own label colour instead of vanishing into its fill. On TV it stays
white.

---

## Tokens at a glance

| Group | Tokens |
|---|---|
| Surfaces | `bg0` app · `bg1` sidebar, cards, list groups · `bg2` inputs, sheets · `bg3` hover, pressed, chips |
| Text | `primary` · `secondary` · `tertiary` · `disabled` · `onAccent` |
| Accent | teal (default and brand), violet, amber — 400 hover / 500 rest / 600 pressed |
| States | `success` · `warning` · `danger` · `info` |
| Borders | `subtle` · `strong` · focus = accent-400 |
| Radii | xs 4 · sm 8 · md 12 · lg 16 · xl 24 · pill 999 |
| Spacing | 4-pt scale 4…64; gutters 16 / 24 / 32 by breakpoint |
| Type | display · title · heading · body · caption · micro, each with a compact / medium / expanded size |
| Elevation | e1 card hover · e2 sheet and dialog |
| Motion | fast 120 ms · base 200 · slow 320 · crossfade 500; hover scale 1.03 |

`constants/theme.test.ts` pins the contrast ratios (secondary on bg1 ≥ 4.5:1,
primary on bg2 ≥ 7:1, on-accent on teal and amber ≥ 7:1), the presence of every
token in the Tailwind extend, and all eighteen variant × breakpoint type sizes.

Violet-500 is the one documented exception: `#9334E9` is the fork's legacy
purple, and no foreground reaches 7:1 against it — white, its best, is 5.4:1 —
so it is held to AA. Raising it needs a darker violet, not a different
foreground.
