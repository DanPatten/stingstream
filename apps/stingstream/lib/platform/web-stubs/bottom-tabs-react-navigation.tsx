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

import { createBottomTabNavigator } from "expo-router/js-tabs";
import type { ComponentProps } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { tabIcon, tabTestID } from "@/components/shell/tabIcons";
import { tokens } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";

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
  rippleColor?: string;
  tabBarStyle?: { backgroundColor?: string } & Record<string, unknown>;
  tabBarActiveTintColor?: string;
  tabBarInactiveTintColor?: string;
};

/** The bar's own height, before the device's bottom inset is added. */
const TAB_BAR_HEIGHT = 56;

/**
 * The compact web tab bar.
 *
 * The native navigator's `tabBarIcon` returns an SF Symbol descriptor on iOS
 * and a `require()`d PNG on Android; on web it returns `{ sfSymbol }`, which is
 * an object nothing can draw — which is why this bar was six words in a row
 * with no glyphs at all. So it does not consult `tabBarIcon`: it draws the same
 * `Icon` the desktop sidebar draws, from the same table
 * (`components/shell/tabIcons.ts`), so a tab looks the same at 390 px as it
 * does at 1440.
 */
function WebTabBar({ state, descriptors, navigation }: any) {
  const insets = useSafeAreaInsets();
  const { accent } = useTheme();

  return (
    <View
      accessibilityRole='tablist'
      style={[
        styles.bar,
        {
          height: TAB_BAR_HEIGHT + insets.bottom,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      {state.routes.map((route: any, index: number) => {
        const { options } = descriptors[route.key];
        // The native navigator's way of hiding a tab; no JS equivalent.
        if (options?.tabBarItemHidden) return null;

        const focused = state.index === index;
        const label = options?.title ?? route.name;

        const onPress = () => {
          const event = navigation.emit({
            type: "tabPress",
            target: route.key,
            canPreventDefault: true,
          });
          if (focused || event.defaultPrevented) return;
          // `target: state.key` is load bearing. Without it the action bubbles
          // to the parent navigator, which has no route called `(favorites)`,
          // and the press does nothing at all — the bug WP-TOOLS recorded in
          // docs/UI-LOOP.md ("the desktop-width bottom tab bar does not
          // navigate"). Written out rather than built with
          // `CommonActions.navigate` because expo-router's Metro check rejects
          // a direct `@react-navigation/*` import.
          navigation.dispatch({
            type: "NAVIGATE",
            payload: { name: route.name, params: route.params, merge: true },
            target: state.key,
          });
        };

        return (
          <Pressable
            key={route.key}
            accessibilityRole='tab'
            accessibilityState={{ selected: focused }}
            // react-native-web 0.21 no longer maps `accessibilityState` onto
            // the DOM, so the selected state needs the W3C prop as well.
            aria-selected={focused}
            accessibilityLabel={options?.tabBarAccessibilityLabel ?? label}
            testID={options?.tabBarButtonTestID ?? tabTestID(route.name)}
            onPress={onPress}
            style={styles.item}
          >
            <Icon
              name={tabIcon(route.name)}
              size={22}
              color={focused ? accent[500] : tokens.color.text.tertiary}
            />
            <Text
              variant='micro'
              weight={focused ? "semibold" : "medium"}
              numberOfLines={1}
              style={{
                marginTop: 2,
                color: focused ? accent[500] : tokens.color.text.tertiary,
              }}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "center",
    borderTopWidth: 1,
    borderTopColor: tokens.color.border.subtle,
    backgroundColor: tokens.color.bg["1"],
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
  labeled: _labeled,
  rippleColor: _rippleColor,
  tabBarStyle: _tabBarStyle,
  tabBarActiveTintColor: _tabBarActiveTintColor,
  tabBarInactiveTintColor: _tabBarInactiveTintColor,
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
      tabBar={(props: any) => <WebTabBar {...props} />}
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
