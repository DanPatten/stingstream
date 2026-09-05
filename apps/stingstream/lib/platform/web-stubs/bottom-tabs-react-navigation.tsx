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
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

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

const ACTIVE_TINT_FALLBACK = "#9333EA";
const INACTIVE_TINT_FALLBACK = "#8E8E93";
const BAR_BACKGROUND_FALLBACK = "#121212";

function WebTabBar({
  state,
  descriptors,
  navigation,
  backgroundColor,
  activeTintColor,
  inactiveTintColor,
}: any) {
  return (
    <View style={[styles.bar, { backgroundColor }]}>
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
          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params);
          }
        };

        return (
          <Pressable
            key={route.key}
            accessibilityRole='button'
            accessibilityState={focused ? { selected: true } : {}}
            accessibilityLabel={options?.tabBarAccessibilityLabel ?? label}
            testID={options?.tabBarButtonTestID ?? `tab-${route.name}`}
            onPress={onPress}
            style={styles.item}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.label,
                { color: focused ? activeTintColor : inactiveTintColor },
              ]}
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
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.12)",
    minHeight: 52,
  },
  item: {
    flexGrow: 1,
    flexBasis: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 6,
  },
  label: { fontSize: 13, fontWeight: "600" },
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
  tabBarStyle,
  tabBarActiveTintColor,
  tabBarInactiveTintColor,
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
      tabBar={(props: any) => (
        <WebTabBar
          {...props}
          backgroundColor={
            tabBarStyle?.backgroundColor ?? BAR_BACKGROUND_FALLBACK
          }
          activeTintColor={tabBarActiveTintColor ?? ACTIVE_TINT_FALLBACK}
          inactiveTintColor={tabBarInactiveTintColor ?? INACTIVE_TINT_FALLBACK}
        />
      )}
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
