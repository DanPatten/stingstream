import { useMemo } from "react";
import {
  type AccentName,
  type AccentPalette,
  accentPalette,
  DEFAULT_ACCENT,
  tokens,
} from "@/constants/theme";
import { useSettings } from "@/utils/atoms/settings";
import { type Breakpoint, useBreakpoint } from "./useBreakpoint";

export interface Theme {
  /** Every design token, exactly as `constants/theme.tokens.json` holds them. */
  tokens: typeof tokens;
  /** The accent the user picked in Appearance; teal unless they changed it. */
  accent: AccentPalette;
  /** Its name, for persisting a choice or keying a swatch. */
  accentName: AccentName;
  /** The current window's breakpoint, so a component needs one hook, not two. */
  breakpoint: Breakpoint;
}

/**
 * The runtime half of the design system.
 *
 * NativeWind v2 compiles Tailwind once at build time and has no CSS variables,
 * so a class can only ever carry the *default* accent. Anything that must
 * follow the user's choice — a primary button, a progress bar, an active nav
 * item, an accent-toned label — reads `accent` from here and sets it inline.
 * Everything else should stay on classes; this is not a licence to inline the
 * whole stylesheet.
 *
 * Deliberately not a provider. `app/_layout.tsx`'s stack is pinned by
 * `CLAUDE.test.ts` and every provider in it is load bearing; the accent already
 * lives in `settingsAtom`, which Jotai broadcasts on its own, so a context
 * around it would buy nothing but a re-render boundary.
 */
export const useTheme = (): Theme => {
  const { settings } = useSettings();
  const breakpoint = useBreakpoint();
  const accentName = (settings?.accent ?? DEFAULT_ACCENT) as AccentName;
  // Only the palette is worth memoising: `useBreakpoint` already returns a
  // fresh object every render, so wrapping the whole result would memoise
  // nothing.
  const accent = useMemo(() => accentPalette(accentName), [accentName]);

  return { tokens, accent, accentName, breakpoint };
};
