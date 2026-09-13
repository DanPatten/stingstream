import {
  Feather,
  Ionicons,
  MaterialCommunityIcons,
  MaterialIcons,
} from "@expo/vector-icons";
import * as Font from "expo-font";
import { useFonts } from "expo-font";

/**
 * Inter, on web. See `fonts.ts` for why this file exists at all.
 *
 * `useFonts` registers a real `FontFace` per family, so `fontFamily:
 * "Inter-SemiBold"` resolves in the browser exactly as it does on a device.
 * The return value is deliberately ignored by the caller: blocking the whole
 * app on four font downloads would trade a moment of fallback type for a blank
 * page, and the startup budget in the plan is measured to first paint.
 */
export const useInterFonts = (): boolean => {
  const [loaded] = useFonts({
    "Inter-Regular": require("@/assets/fonts/Inter-Regular.ttf"),
    "Inter-Medium": require("@/assets/fonts/Inter-Medium.ttf"),
    "Inter-SemiBold": require("@/assets/fonts/Inter-SemiBold.ttf"),
    "Inter-Bold": require("@/assets/fonts/Inter-Bold.ttf"),
  });
  return loaded;
};

// ---------------------------------------------------------------------------
// Icon fonts, and why they are registered here rather than by the icons
// ---------------------------------------------------------------------------
//
// **Every icon in the app was invisible in Firefox.** Dan, on a Pixel: "Icons
// are missing on responsive view at the bottom" — the tab bar, the play
// triangle, the chevron after "See all", all of them, while the header's gear
// (Material Symbols, a different package) drew fine. Reproduced in Gecko at
// 412 px: the icons are in the DOM as `<div dir="auto"></div>`, empty, and the
// console carries one `Error: 12000ms timeout exceeded` per icon mounted.
//
// `@expo/vector-icons` renders `<Text />` — nothing — until it believes its
// font is ready:
//
//     state = { fontIsLoaded: Font.isLoaded(fontName) };
//     async componentDidMount() {
//       if (!this.state.fontIsLoaded) {
//         await Font.loadAsync(font);          // rejects in Gecko
//         this.setState({ fontIsLoaded: true });
//       }
//     }
//     render() { if (!this.state.fontIsLoaded) return <Text />; ... }
//
// and `expo-font`'s web loader confirms a load with `fontfaceobserver`, which
// measures a test string in the new font against the fallbacks. The default
// string is "BESbswy" — an icon font has no glyphs for any of those letters, so
// the measurements never diverge. Blink resolves anyway through the CSS Font
// Loading API; Gecko does not, the 12-second timer wins, the `await` throws,
// and `fontIsLoaded` stays false forever. The font itself is blameless: on the
// same phone a bare `@font-face` and a `FontFace` both paint the glyph, 48 px
// wide, from the same URL.
//
// So the fonts are registered here, at module scope, before React renders
// anything. `Font.loadAsync` injects the `@font-face` rule synchronously and
// only the *verification* is async, so by the time an icon mounts
// `Font.isLoaded` is already true and it renders its glyph on the first pass,
// with the browser fetching the file the way it fetches any other web font.
// The test string is a real glyph from each family as well, which lets the
// observer settle instead of throwing — belt and braces, since the rule being
// there is what actually fixes the icons.
//
// Native is untouched: this file is `.web.ts`, and a device has these fonts
// linked at build time.

/** Every `@expo/vector-icons` family the app draws. Add one here when you import one. */
const ICON_FAMILIES = [
  Ionicons,
  Feather,
  MaterialCommunityIcons,
  MaterialIcons,
];

/**
 * A string the font in question actually has a glyph for.
 *
 * Taken from the family's own glyph map rather than written down: a codepoint
 * copied into a comment here is one an upstream release can retire, and the
 * failure mode would be this silently going back to the "BESbswy" behaviour it
 * exists to avoid.
 */
const testStringFor = (
  family: (typeof ICON_FAMILIES)[number],
): string | undefined => {
  const codepoint = Object.values(family.getRawGlyphMap())[0];
  return typeof codepoint === "number"
    ? String.fromCodePoint(codepoint)
    : undefined;
};

for (const family of ICON_FAMILIES) {
  const entry = Object.entries(family.font)[0];
  if (!entry) continue;
  const [fontFamily, asset] = entry;
  // Fire and forget. The rule lands synchronously, which is the part that
  // matters; the promise only reports whether the observer could confirm it.
  Font.loadAsync({
    [fontFamily]: { uri: asset as never, testString: testStringFor(family) },
  }).catch(() => {
    // A font that cannot be verified still renders — see above. Swallowing
    // this is also what keeps 26 unhandled rejections out of the console.
  });
}
