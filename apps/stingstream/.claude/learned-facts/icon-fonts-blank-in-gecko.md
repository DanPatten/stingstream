# Every Icon Is Blank in Firefox Unless the Font Is Registered Before React Renders

**Date**: 2026-09-12
**Category**: ui, web
**Key files**: `constants/fonts.web.ts`, `components/common/Icon.tsx`,
`node_modules/@expo/vector-icons/build/createIconSet.js`,
`node_modules/expo-font/build/ExpoFontLoader.web.js`

## Detail

Dan, testing the web build on a Pixel: *"Icons are missing on responsive view at the
bottom"*. Every `@expo/vector-icons` glyph in the app was invisible — the bottom tab bar, the
hero's play triangle, the chevron after "See all" — while the header's gear kept drawing,
because that one is `expo-symbols`' Material Symbols and not this package. The browser was
**Firefox for Android**, and it reproduces in desktop Gecko at any width; Chromium is fine,
which is why three passes of Chromium screenshots showed nothing.

**It is not the font.** A diagnostic page on the same phone painted the Ionicons glyph at
48 px from the same URL, through both a plain `@font-face` and the `FontFace` API, with the
file arriving as `font/ttf`, 389,724 bytes, correct magic.

The icons are in the DOM as `<div dir="auto"></div>` — empty — and the console carries one
`Error: 12000ms timeout exceeded` per icon mounted. `@expo/vector-icons` renders nothing until
it believes the font is ready:

```js
state = { fontIsLoaded: Font.isLoaded(fontName) };
async componentDidMount() {
  if (!this.state.fontIsLoaded) {
    await Font.loadAsync(font);        // rejects in Gecko
    this.setState({ fontIsLoaded: true });
  }
}
render() { if (!this.state.fontIsLoaded) return <Text />; ... }
```

and `expo-font`'s web loader confirms the load with `fontfaceobserver`, which measures a test
string in the new font against the fallbacks. Its default string is `"BESbswy"`, and an icon
font has no glyph for any of those letters, so the measurements never diverge. Blink resolves
anyway through the CSS Font Loading API; Gecko lets the 12-second timer win, the `await`
throws, and `fontIsLoaded` stays false for the life of the component.

**The fix is ordering, not loading.** `Font.isLoaded` on web only asks whether an
`@font-face` rule exists, and `Font.loadAsync` injects that rule *synchronously* — only the
verification is async. `constants/fonts.web.ts` therefore calls it at module scope, before
React renders anything, for every family the app imports. Icons then see `fontIsLoaded: true`
on their first render and the browser fetches the file the way it fetches any web font. Each
call also passes a `testString` taken from the family's own glyph map, so the observer settles
instead of throwing 26 unhandled rejections into the console.

Add a line to `ICON_FAMILIES` when you import a new `@expo/vector-icons` family. Without it
that family's glyphs are blank in Firefox and nowhere else.

## Symptom pattern

Glyphs missing in Firefox but present in Chrome, `<div dir="auto"></div>` where an icon
should be, and `Error: 12000ms timeout exceeded` repeated in the console. Screenshot tooling
that only drives Chromium cannot see any of it.
