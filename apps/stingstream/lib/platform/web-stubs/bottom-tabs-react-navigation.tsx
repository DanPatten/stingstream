/**
 * Web stub for `@bottom-tabs/react-navigation` (StingStream M2 web target).
 *
 * `@bottom-tabs/react-navigation` renders the *platform-native* tab bar
 * (UITabBarController / BottomNavigationView) through a fabric component, so it
 * hard-fails to even bundle on web: `react-native-bottom-tabs` reaches into
 * `react-native/Libraries/Utilities/codegenNativeComponent`, which Metro refuses
 * to resolve for `platform === "web"`.
 *
 * This file provides a drop-in `createNativeBottomTabNavigator()` backed by
 * Expo Router's bundled JS bottom-tab navigator (`expo-router/js-tabs`), plus a
 * custom tab bar. The custom bar exists because the two navigators disagree on
 * option shapes — the native one takes `tabBarIcon` returning either an SF
 * Symbol descriptor (`{ sfSymbol }`) or a `require()`d image module, and hides
 * items with `tabBarItemHidden`; neither means anything to the JS navigator.
 * Rendering the bar ourselves from `options.title` + `options.tabBarItemHidden`
 * sidesteps the mismatch entirely, so `app/(auth)/(tabs)/_layout.tsx` is used
 * verbatim on web with no source change and no behaviour change on native
 * (Metro only substitutes this file when bundling for web — see
 * `webModuleStubs` in `metro.config.js`).
 */

import { usePathname, useRouter } from "expo-router";
import { createBottomTabNavigator } from "expo-router/js-tabs";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Icon } from "@/components/common/Icon";
import {
  isBehindMore,
  tabIcon,
  tabNavigateTarget,
  tabTestID,
} from "@/components/shell/tabIcons";
import { useTheme } from "@/hooks/useTheme";
import { useNavDrawer } from "@/utils/atoms/navDrawer";

const { Navigator: JsBottomTabNavigator } = createBottomTabNavigator();

type JsNavigatorProps = ComponentProps<typeof JsBottomTabNavigator>;

/** Options the native navigator understands and the JS one does not. */
type NativeOnlyNavigatorProps = {
  sidebarAdaptable?: boolean;
  activeIndicatorColor?: string;
  scrollEdgeAppearance?: string;
  translucent?: boolean;
  hapticFeedbackEnabled?: boolean;
  disablePageAnimations?: boolean;
  labeled?: boolean;
  tabLabelStyle?: {
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: string;
  };
  rippleColor?: string;
  tabBarStyle?: { backgroundColor?: string } & Record<string, unknown>;
  tabBarActiveTintColor?: string;
  tabBarInactiveTintColor?: string;
  /**
   * Real in the native package, and load bearing here: above 768 px the web
   * shell puts a sidebar where the bar would be, and the navigator underneath
   * has to be the same one it was at 767 — see `WebShellLayout`.
   */
  tabBarHidden?: boolean;
};

/** The bar's whole height; see the note on the bar's style for why no inset. */
const TAB_BAR_HEIGHT = 56;

/** Big enough to carry a section on its own, now that no word is under it. */
const TAB_ICON_SIZE = 24;

/**
 * The compact web tab bar: four sections and the menu.
 *
 * The native navigator's `tabBarIcon` returns an SF Symbol descriptor on iOS
 * and a `require()`d PNG on Android; on web it returns `{ sfSymbol }`, which is
 * an object nothing can draw — which is why this bar was six words in a row
 * with no glyphs at all. So it does not consult `tabBarIcon`: it draws the same
 * `Icon` the desktop sidebar draws, from the same table
 * (`components/shell/tabIcons.ts`), so a tab looks the same at 390 px as it
 * does at 1440.
 *
 * **Glyphs only, and a hamburger where More was.** Dan, reviewing the browser
 * at phone width: "use icons at the bottom instead of names ... get rid of that
 * more button (hamburger instead)". A word under each glyph bought nothing that
 * a house, a magnifier and a stack of posters do not already say, and it is
 * what forced the bar down to five destinations in the first place; the last
 * slot now opens the drawer (`components/shell/MobileShell.tsx`), which holds
 * every section the bar cannot, the libraries and the account included. The
 * native iOS and Android bars are untouched: they are platform tab bars, where
 * a labelled item is the convention and no fifth item can open anything but a
 * screen.
 */
function WebTabBar({ state, descriptors, navigation }: any) {
  const { color, accent } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();
  const drawer = useNavDrawer();

  // What the drawer opened, rather than what a tab button did. Settings and
  // Sessions live inside the `(home)` stack, so without this the bar lit Home
  // while you were reading Settings; Favorites and Transfers have no button at
  // all, and used to light More.
  const current = state.routes[state.index]?.name;
  const fromDrawer =
    isBehindMore(current) ||
    current === "(settings)" ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/sessions");

  return (
    <View
      accessibilityRole='tablist'
      testID='shell-tabbar'
      style={[
        styles.bar,
        {
          // No bottom safe-area inset, on purpose. `public/index.html` does not
          // ask for `viewport-fit=cover`, so the page never draws under the
          // system bars and the inset should read 0. Firefox on Android reports
          // the navigation bar's height anyway (~41 px on a Pixel with
          // three-button nav), which padded the bar into a strip of empty
          // space below its icons. Dan: "a gap on responsive web on Firefox at
          // the bottom where the icons go".
          height: TAB_BAR_HEIGHT,
          // Inline rather than in `styles`: a module-scope StyleSheet is one
          // theme's answer baked into the bundle.
          borderTopColor: color.border.subtle,
          backgroundColor: color.bg["1"],
        },
      ]}
    >
      {state.routes.map((route: any, index: number) => {
        const { options } = descriptors[route.key];
        // The native navigator's way of hiding a tab; no JS equivalent.
        if (options?.tabBarItemHidden) return null;
        // The native bar's fifth button is More, whose screen is a list of the
        // sections it could not fit. Here that is the drawer, below.
        if (route.name === "(settings)") return null;

        const focused = state.index === index && !fromDrawer;
        const label = options?.title ?? route.name;

        const onPress = () => {
          const event = navigation.emit({
            type: "tabPress",
            target: route.key,
            canPreventDefault: true,
          });
          if (event.defaultPrevented) return;
          // By URL, not by a NAVIGATE action aimed at this navigator.
          //
          // A dispatch switches the tab but leaves the group on its `index`,
          // and a group's index is `/` — so the address bar said `/` whatever
          // you pressed, the browser's back button had nothing to go back to,
          // and a refresh landed on Home (pass-02 F-20). `tabNavigateTarget`
          // gives each section the address of its named route, and expo-router
          // does the rest, history included.
          //
          // Not gated on `focused` any more: Home's glyph was lit whenever the
          // reader was anywhere in the home stack — Settings, say — and a lit
          // button that refuses to navigate is the Home button doing nothing,
          // which is exactly what Dan reported.
          router.navigate(tabNavigateTarget(route.name) as never);
        };

        return (
          <Pressable
            key={route.key}
            accessibilityRole='tab'
            accessibilityState={{ selected: focused }}
            // react-native-web 0.21 no longer maps `accessibilityState` onto
            // the DOM, so the selected state needs the W3C prop as well.
            aria-selected={focused}
            // The glyph stands alone now, so the name it lost is the only thing
            // a screen reader has to go on.
            accessibilityLabel={options?.tabBarAccessibilityLabel ?? label}
            testID={options?.tabBarButtonTestID ?? tabTestID(route.name)}
            onPress={onPress}
            style={styles.item}
          >
            <Icon
              name={tabIcon(route.name)}
              size={TAB_ICON_SIZE}
              color={focused ? accent[500] : color.text.tertiary}
            />
          </Pressable>
        );
      })}

      <Pressable
        accessibilityRole='button'
        accessibilityLabel={t("shell.menu")}
        accessibilityState={{ expanded: drawer.open }}
        aria-expanded={drawer.open}
        testID='shell-menu'
        onPress={drawer.toggle}
        style={styles.item}
      >
        <Icon
          name='menu'
          size={TAB_ICON_SIZE}
          color={drawer.open || fromDrawer ? accent[500] : color.text.tertiary}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "center",
    borderTopWidth: 1,
  },
  item: {
    flexGrow: 1,
    flexBasis: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
});

function NativeBottomTabsWebNavigator({
  sidebarAdaptable: _sidebarAdaptable,
  activeIndicatorColor: _activeIndicatorColor,
  scrollEdgeAppearance: _scrollEdgeAppearance,
  translucent: _translucent,
  hapticFeedbackEnabled: _hapticFeedbackEnabled,
  disablePageAnimations: _disablePageAnimations,
  // The bar below decides for itself whether it can afford labels, from the
  // same width rule the native navigator is given.
  labeled: _labeled,
  tabLabelStyle: _tabLabelStyle,
  rippleColor: _rippleColor,
  tabBarStyle: _tabBarStyle,
  tabBarActiveTintColor: _tabBarActiveTintColor,
  tabBarInactiveTintColor: _tabBarInactiveTintColor,
  tabBarHidden,
  screenOptions,
  ...rest
}: NativeOnlyNavigatorProps & Record<string, any>) {
  return (
    <JsBottomTabNavigator
      {...(rest as JsNavigatorProps)}
      screenOptions={
        {
          headerShown: false,
          ...(typeof screenOptions === "object" ? screenOptions : null),
        } as any
      }
      tabBar={
        tabBarHidden ? () => null : (props: any) => <WebTabBar {...props} />
      }
    />
  );
}

export function createNativeBottomTabNavigator() {
  const factory = createBottomTabNavigator();
  return {
    ...factory,
    Navigator: NativeBottomTabsWebNavigator as any,
  };
}

/** Matches the native package's named export surface closely enough to type-check. */
export type NativeBottomTabNavigationOptions = Record<string, any>;
export type NativeBottomTabNavigationEventMap = Record<string, any>;
export type NativeBottomTabNavigationProp<
  _P = any,
  _R = any,
  _S = any,
> = Record<string, any>;
export type NativeBottomTabScreenProps<_P = any, _R = any> = Record<
  string,
  any
>;

export const SUPPORTS_NATIVE_TABS = Platform.OS !== "web";

export default createNativeBottomTabNavigator;
