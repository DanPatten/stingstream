import { DEFAULT_PALETTE, rgba, tokens } from "./theme";

/**
 * The fork's original nine-color palette, kept as aliases of the design
 * tokens.
 *
 * Eighty-odd call sites imported `Colors`, and rewriting them all in one commit
 * would have collided with every other package in flight. So the names stayed
 * and the values moved.
 *
 * **It cannot follow the theme.** These are module constants, so everything they
 * paint is stuck on the default theme's colors whatever the person picked in
 * Appearance. That is why the remaining call sites are being moved to
 * `useTheme().color`, and why this file is on its way out — do not add to it.
 */
const brand = DEFAULT_PALETTE.accent;

export const Colors = {
  /** Accent 500 — the rest state of anything accented. */
  primary: brand[500],
  primaryRGB: rgba(brand[500], 1),
  /** Accent 400 — hover. */
  primaryLightRGB: rgba(brand[400], 1),
  text: DEFAULT_PALETTE.text.primary,
  background: DEFAULT_PALETTE.bg["0"],
  /** The TV focus ring, which is white on every theme. See docs/conventions/tv.md. */
  tint: tokens.focus.tv.color,
  icon: DEFAULT_PALETTE.text.secondary,
  tabIconDefault: DEFAULT_PALETTE.text.secondary,
  tabIconSelected: brand.active,
};
