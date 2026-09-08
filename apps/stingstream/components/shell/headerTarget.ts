import type { ViewStyle } from "react-native";

/**
 * The box a header icon button occupies.
 *
 * `HeaderButton` sizes itself to the glyph (24 dp) and buys the rest of the
 * touch target with `hitSlop`, which is invisible to the DOM: on web the
 * element really is 24×24, so pass-03's sweep counted six screens' worth of
 * sub-40 px targets (F-52) and a pointer has 24 px of ink to hit rather than a
 * thumb-sized square. `hitSlop` is also not what a *mouse* respects in every
 * browser, and it does nothing at all for the focus ring's size.
 *
 * 44 is Apple's HIG minimum and comfortably over the 40 the sweep asks for; the
 * glyph stays 24 and centres itself in the box, so nothing moves visually
 * except the hover and focus surface, which grows to something you can hit.
 *
 * Spread it last — `HeaderButton` puts the caller's `style` after its own.
 */
export const HEADER_TARGET_SIZE = 44;

export const headerTarget: ViewStyle = {
  height: HEADER_TARGET_SIZE,
  width: HEADER_TARGET_SIZE,
  minWidth: HEADER_TARGET_SIZE,
};
