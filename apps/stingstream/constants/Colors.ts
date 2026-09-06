import { accentPalette, rgba, tokens } from "./theme";

/**
 * The fork's original nine-colour palette, kept as aliases of the design
 * tokens.
 *
 * Eighty-odd call sites import `Colors`, and rewriting them all in one commit
 * would collide with every other package in flight. So the names stay and the
 * values move: `Colors.primary` is now the brand accent rather than Streamyfin's
 * purple, `Colors.background` is `bg0`, and so on. New code should read
 * `constants/theme.ts` (or `useTheme()`, which follows the user's chosen accent)
 * instead — this object cannot express a tone, a variant or a runtime accent.
 */
const brand = accentPalette();

export const Colors = {
  /** Accent 500 — the rest state of anything accented. */
  primary: brand[500],
  primaryRGB: rgba(brand[500], 1),
  /** Accent 400 — hover, and the focus ring on web. */
  primaryLightRGB: rgba(brand[400], 1),
  text: tokens.color.text.primary,
  background: tokens.color.bg["0"],
  tint: "#FFFFFF",
  icon: tokens.color.text.secondary,
  tabIconDefault: tokens.color.text.secondary,
  tabIconSelected: brand[500],
};
