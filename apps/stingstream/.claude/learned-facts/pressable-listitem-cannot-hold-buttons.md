# A Pressable ListItem Cannot Hold Row Action Buttons

**Date**: 2026-09-09
**Category**: ui
**Key files**: `components/list/ListItem.tsx`, `components/stingstream/users/UsersScreen.tsx`

## Detail

`ListItem` with an `onPress` renders a `Pressable` with `accessibilityRole="button"`,
and react-native-web turns that into a real `<button>` element — not a
`<div role="button">`. So does `components/Button.tsx`. Putting row actions
(the icon-only `<Button variant='ghost' …>{""}</Button>` pattern) inside that
row's `iconAfter` therefore nests `<button>` inside `<button>`, which is
invalid HTML. React says so at runtime:

```
In HTML, <button> cannot be a descendant of <button>. This will cause a hydration error.
```

It is not only a console warning. A nested interactive element is flattened
into its ancestor for assistive technology, so the whole row reads as one
control and the actions become unreachable by keyboard and screen reader.

The fix is structural, not a prop: make the pressable label and the action
buttons **siblings**. `UsersScreen`'s `RowShell` is the worked example — a plain
`View` for the row, one `Pressable` holding the avatar and the text at `flex: 1`,
and the buttons in a sibling `View`. It copies `ListItem`'s metrics (44 px floor,
16 px gutter, the `usePressableStates` hover/pressed tints) so it still sits in a
`ListGroup` beside real `ListItem`s without looking almost-but-not-quite the same,
and it accepts `style` because `ListGroup` clones the hairline separator onto its
children.

`ListItem` remains right for a row whose trailing slot is *not* interactive — a
`Pill`, an `Icon`, a `Switch` behind a `View pointerEvents="none"`.

## Symptom pattern

Two console errors on a list screen at any width — `"In HTML, %s cannot be a
descendant of <%s>"` followed by `"<%s> cannot contain a nested %s"` — with a
component stack that ends in `ListItem → Pressable → button → … → Button →
Pressable → button`. The screen looks correct in a screenshot, which is why this
survives review; the ancestor stack in the first error names the guilty row.
