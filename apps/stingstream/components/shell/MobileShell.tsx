import { usePathname } from "expo-router";
import { type PropsWithChildren, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Animated, Easing, Platform, Pressable, View } from "react-native";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import { useNavDrawer } from "@/utils/atoms/navDrawer";
import { SIDEBAR_WIDTH, Sidebar } from "./Sidebar";
import { useShellNavigation } from "./useShellNavigation";

/** How wide the panel is, and how much of the page stays visible beside it. */
const MAX_DRAWER_WIDTH = 320;
const MIN_PAGE_VISIBLE = 56;

/** Long enough to read as a movement, short enough not to be a wait. */
const SLIDE_MS = 180;

/**
 * The chrome below 768 px: the page, and the drawer the tab bar's last button
 * opens.
 *
 * The bar itself is four sections and a hamburger (see the web stub for
 * `@bottom-tabs/react-navigation`), because five thumb-sized buttons is all a
 * 360 px bar has room for and the app has a dozen destinations. Everything the
 * bar cannot hold — your libraries, Favorites, Transfers, Settings, the account
 * — is in here, and it is the *same* list the desktop sidebar draws, from the
 * same `useShellNavigation`, so a narrow window is the wide one with its column
 * hidden rather than a second navigation with its own opinions.
 *
 * It replaces the More *tab*, which was a screen you navigated to in order to
 * navigate again: it took a route of its own, pushed the destination into a tab
 * with no button, and left those screens needing a bespoke chevron back to it.
 * A drawer is drawn over whatever you were reading and closes again, so nothing
 * about the page underneath changes.
 */
export const MobileShell: React.FC<PropsWithChildren> = ({ children }) => (
  <View style={{ flex: 1 }}>
    {children}
    <NavDrawer />
  </View>
);

const NavDrawer: React.FC = () => {
  const { color } = useTheme();
  const { t } = useTranslation();
  const { width } = useBreakpoint();
  const pathname = usePathname();
  const { open, close } = useNavDrawer();
  const { sections, activeKey, goHome, onSelect } = useShellNavigation();

  const panelWidth = Math.min(
    MAX_DRAWER_WIDTH,
    Math.max(SIDEBAR_WIDTH, width - MIN_PAGE_VISIBLE),
  );

  // `useRef`, so the panel does not restart its slide every time the page
  // behind it re-renders.
  const progress = useRef(new Animated.Value(0)).current;
  // Kept mounted through the closing slide, and only then unmounted: a drawer
  // that vanishes the moment it is dismissed never appears to close at all.
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) setMounted(true);
    const animation = Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: SLIDE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !open) setMounted(false);
    });
    return () => animation.stop();
  }, [open, progress]);

  // A destination closes it. Every row does that through `select` below, but a
  // link inside the drawer's own account menu, the browser's back button and a
  // deep link all change the route without going through it.
  useEffect(() => {
    close();
  }, [pathname, close]);

  // Dragging the window past 768 px swaps this whole frame for the desktop one.
  // The atom would otherwise stay true and the drawer would be sitting open if
  // the window ever came back.
  useEffect(() => close, [close]);

  // Escape, which is what every overlay on the web answers to.
  useEffect(() => {
    if (Platform.OS !== "web" || !open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    globalThis.addEventListener?.("keydown", onKeyDown);
    return () => globalThis.removeEventListener?.("keydown", onKeyDown);
  }, [open, close]);

  if (!mounted) return null;

  const select = (item: Parameters<typeof onSelect>[0]) => {
    onSelect(item);
    close();
  };

  return (
    <View
      testID='shell-drawer'
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        flexDirection: "row",
      }}
    >
      <Animated.View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: color.scrim,
          opacity: progress,
        }}
      >
        <Pressable
          testID='shell-drawer-scrim'
          accessibilityRole='button'
          accessibilityLabel={t("shell.close_menu")}
          onPress={close}
          style={{ flex: 1 }}
        />
      </Animated.View>

      <Animated.View
        style={{
          width: panelWidth,
          transform: [
            {
              translateX: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [-panelWidth, 0],
              }),
            },
          ],
        }}
      >
        <Sidebar
          variant='drawer'
          width={panelWidth}
          sections={sections}
          activeKey={activeKey}
          collapsed={false}
          onSelect={select}
          onPressBrand={() => {
            goHome();
            close();
          }}
          onToggleCollapsed={close}
        />
      </Animated.View>
    </View>
  );
};

export default MobileShell;
