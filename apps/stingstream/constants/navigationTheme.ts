import { DarkTheme, DefaultTheme } from "expo-router/react-navigation";
import {
  DEFAULT_PALETTE,
  DEFAULT_THEME,
  type ThemeName,
  type ThemePalette,
} from "./theme";

type NavigationTheme = typeof DarkTheme;

/**
 * React Navigation's theme, built from a palette.
 *
 * `DarkTheme` and `DefaultTheme` are React Navigation's own palettes — a
 * #1C1C1E card on #000, or #FFF with the iOS system blue — and between them
 * they paint every native stack header, back chevron and screen background in
 * the app. Left alone they are the one surface the design system does not
 * reach, and it shows: a header one shade off the page it sits above is exactly
 * the kind of seam that reads as "not quite an app".
 *
 * Spread from the base rather than written out, so a future React Navigation
 * release that adds a color gets a sensible default instead of a crash.
 */
const build = (palette: ThemePalette): NavigationTheme => {
  const base = palette.scheme === "light" ? DefaultTheme : DarkTheme;
  return {
    ...base,
    dark: palette.scheme === "dark",
    colors: {
      ...base.colors,
      background: palette.bg[0],
      card: palette.bg[1],
      text: palette.text.primary,
      border: palette.border.subtle,
      primary: palette.accent[500],
      notification: palette.state.danger,
    },
  };
};

/**
 * Cached by theme name, because React Navigation re-renders the whole navigator
 * when the theme's *identity* changes. Rebuilding the object each render would
 * remount every screen on every keystroke.
 */
const cache = new Map<ThemeName, NavigationTheme>();

export const navigationTheme = (
  name: ThemeName,
  palette: ThemePalette,
): NavigationTheme => {
  const hit = cache.get(name);
  if (hit) return hit;
  const built = build(palette);
  cache.set(name, built);
  return built;
};

/** For anything genuinely outside React. Components use `useNavigationTheme()`. */
export const DEFAULT_NAVIGATION_THEME = navigationTheme(
  DEFAULT_THEME,
  DEFAULT_PALETTE,
);
