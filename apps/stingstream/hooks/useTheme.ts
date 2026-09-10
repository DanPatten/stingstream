import {
  type AccentRamp,
  type ColorScheme,
  DEFAULT_THEME,
  type ThemeName,
  type ThemePalette,
  themePalette,
  tokens,
} from "@/constants/theme";
import { useSettings } from "@/utils/atoms/settings";
import { type Breakpoint, useBreakpoint } from "./useBreakpoint";

export interface Theme {
  /** Every color, resolved for the theme the user picked. */
  color: ThemePalette;
  /** `color.accent`, hoisted: it is read more often than the rest put together. */
  accent: AccentRamp;
  /** Its name, for persisting a choice or keying a swatch. */
  themeName: ThemeName;
  /** `"dark"` or `"light"` — a status bar style, a keyboard appearance, a blur tint. */
  scheme: ColorScheme;
  /** Everything that is *not* color: radius, space, type, motion, focus, interaction. */
  tokens: typeof tokens;
  /** The current window's breakpoint, so a component needs one hook, not two. */
  breakpoint: Breakpoint;
}

/**
 * The runtime half of the design system.
 *
 * NativeWind v2 compiles Tailwind once at build time and has no CSS variables,
 * so a class can only ever carry one theme's answer. Anything with a color in
 * it — a surface, a label, a border, a primary button, a focus ring — reads
 * `color` from here and sets it inline.
 *
 * Deliberately not a provider. `app/_layout.tsx`'s stack is pinned by
 * `CLAUDE.test.ts` and every provider in it is load bearing; the theme already
 * lives in `settingsAtom`, which Jotai broadcasts on its own, so a context
 * around it would buy nothing but a re-render boundary.
 */
export const useTheme = (): Theme => {
  const { settings } = useSettings();
  const breakpoint = useBreakpoint();
  const themeName = (settings?.theme ?? DEFAULT_THEME) as ThemeName;
  // No memo: `themePalette` hands back the same object off the token module
  // every time, and `useBreakpoint` returns a fresh object each render anyway,
  // so there is nothing here a memo could stabilise.
  const color = themePalette(themeName);

  return {
    color,
    accent: color.accent,
    themeName,
    scheme: color.scheme,
    tokens,
    breakpoint,
  };
};
