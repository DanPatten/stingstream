import { Stack } from "expo-router";
import { type ComponentProps, useMemo } from "react";
import { Platform } from "react-native";
import { HeaderGradient } from "@/components/common/HeaderGradient";
import { resolveTextStyle, tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";

type ICommonScreenOptions = ComponentProps<typeof Stack.Screen>["options"];

/**
 * Applied via `<Stack screenOptions={...}>` in every tab layout.
 *
 * The native stack renders its own back button, aligned by UIKit / the Android
 * Toolbar, so screens must never supply a custom `headerLeft` just to go back —
 * that is what knocked every header out of alignment. These two options are all
 * it takes to match the app's look: a white chevron with no back title.
 *
 * `scrollEdgeEffects.top` is hidden because on iOS 26 UIKit paints a soft blur
 * under the navigation bar of any inset-adjusted scroll view, which defeats the
 * fully transparent headers this app uses. Readability over content comes from
 * `headerBackground` instead: a dark-to-transparent scrim behind every header.
 */
export const stackScreenOptions: ICommonScreenOptions = {
  headerTintColor: "white",
  headerBackButtonDisplayMode: "minimal",
  scrollEdgeEffects: { top: "hidden" },
  headerBackground:
    Platform.OS === "ios" ? () => <HeaderGradient /> : undefined,
};

/**
 * What every tab group's `<Stack>` should actually be given.
 *
 * `stackScreenOptions` above is a constant, and the desktop shell needs two
 * things it cannot express: the tab-root header has to disappear (the `TopBar`
 * says where you are instead — two titles stacked on top of each other was half
 * of what "clunky" meant), and the header that remains on a sub-page has to be
 * drawn from tokens rather than from UIKit's defaults.
 *
 * **Off the wide web it returns the old constant unchanged**, deliberately: the
 * phone and television headers are tuned to their platforms (the iOS gradient,
 * the TV convention that there is no header at all) and this package has no
 * business restyling either.
 *
 * `headerShown` belongs here rather than on each screen because a screen that
 * sets it wins, and a tab root that does so would keep its header on the
 * desktop. So the nine tab layouts leave `headerShown` off their `index`
 * screen and set it on their sub-pages, which is exactly the split we want:
 * roots lose the header on web wide, sub-pages keep one to go back with.
 */
export function useStackScreenOptions(): ICommonScreenOptions {
  const { isWebWide, name } = useBreakpoint();
  const { accent } = useTheme();

  return useMemo(() => {
    // `!Platform.isTV` is what all nine `index` screens used to declare for
    // themselves; moving it here is what lets them drop the line, and keeps a
    // television header-free exactly as before.
    if (!isWebWide) {
      return { ...stackScreenOptions, headerShown: !Platform.isTV };
    }

    const title = resolveTextStyle("heading", "primary", "semibold", name);
    return {
      ...stackScreenOptions,
      headerShown: false,
      // The back chevron is the one interactive thing in the header, so it is
      // the one thing that takes the accent.
      headerTintColor: accent[500],
      headerStyle: { backgroundColor: tokens.color.bg["0"] },
      headerTitleStyle: {
        color: title.color,
        fontFamily: title.fontFamily,
        fontSize: title.fontSize,
      },
      headerShadowVisible: false,
      // Every screen's own background, so a short page does not show the
      // browser's white through the bottom of the column.
      contentStyle: { backgroundColor: tokens.color.bg["0"] },
    } satisfies ICommonScreenOptions;
  }, [isWebWide, name, accent]);
}

export const commonScreenOptions: ICommonScreenOptions = {
  title: "",
  headerShown: !Platform.isTV,
  headerTransparent: Platform.OS === "ios",
  headerShadowVisible: false,
  headerBlurEffect: "none",
};

const routes = [
  "persons/[personId]",
  "items/page",
  "series/[id]",
  "music/album/[albumId]",
  "music/artist/[artistId]",
  "music/playlist/[playlistId]",
];

export const nestedTabPageScreenOptions: Record<string, ICommonScreenOptions> =
  Object.fromEntries(routes.map((route) => [route, commonScreenOptions]));
