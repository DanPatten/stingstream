import { navigationTheme } from "@/constants/navigationTheme";
import { useTheme } from "./useTheme";

/**
 * The React Navigation theme for the theme the user picked.
 *
 * Handed to the `ThemeProvider` that already sits at the bottom of
 * `app/_layout.tsx`'s stack, so the native headers and screen backgrounds
 * follow Appearance the way the rest of the app does. `navigationTheme` caches
 * by name, so the identity only changes when the choice does.
 */
export const useNavigationTheme = () => {
  const { themeName, color } = useTheme();
  return navigationTheme(themeName, color);
};
