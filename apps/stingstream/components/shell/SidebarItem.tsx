import { Ionicons } from "@expo/vector-icons";
import { useRef, useState } from "react";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, tokens, webFocusRing } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import type { SidebarItem as SidebarItemModel } from "./buildSidebarItems";
import { useFocusVisible } from "./useFocusVisible";

export const SIDEBAR_ROW_HEIGHT = 40;

interface Props {
  item: SidebarItemModel;
  active: boolean;
  /** The 72 px icon rail (medium widths): glyph only, label on hover. */
  collapsed: boolean;
  onPress: () => void;
  /**
   * The rail's hover label. Reported up rather than drawn here: an absolutely
   * positioned box shrinks to fit its containing block, and a row's containing
   * block on the rail is the `ScrollView`'s 48 px of content width — so the
   * tooltip has to be a child of `Sidebar` instead, where there is room.
   */
  onHoverChange?: (label: string | null, screenY: number) => void;
}

/**
 * One row of the sidebar.
 *
 * Three states have to be legible at a glance and never all at once: *where you
 * are* (an accent bar and a lighter fill), *what you are pointing at* (fill
 * only), and *what the keyboard is on* (the accent outline). The last one is
 * gated on `useFocusVisible` because `onFocus` fires on a click too, and a ring
 * around the row you just clicked — which already has the bar and the fill —
 * reads as a bug rather than as focus.
 */
export const SidebarItem: React.FC<Props> = ({
  item,
  active,
  collapsed,
  onPress,
  onHoverChange,
}) => {
  const { accentName, accent } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showRing = useFocusVisible(focused);
  const ref = useRef<View>(null);

  const background = active || hovered ? tokens.color.bg["3"] : "transparent";
  const tone = active ? "primary" : "secondary";
  const glyphColor = active ? accent[500] : tokens.color.text.secondary;

  const hoverIn = () => {
    setHovered(true);
    if (!collapsed || !onHoverChange) return;
    ref.current?.measureInWindow((_x, y) => onHoverChange(item.label, y));
  };

  const hoverOut = () => {
    setHovered(false);
    onHoverChange?.(null, 0);
  };

  return (
    <Pressable
      ref={ref}
      testID={item.testID}
      accessibilityRole='link'
      accessibilityLabel={item.label}
      accessibilityState={{ selected: active }}
      // `aria-current="page"` is the right mark-up for "this is the nav row you
      // are on", and react-native-web passes it through untouched — but React
      // Native's own prop types have no `aria-current`, so it has to go in as a
      // spread. `accessibilityState` above is the native half; react-native-web
      // 0.21 no longer puts it on the DOM at all.
      {...(active ? ({ "aria-current": "page" } as object) : null)}
      onPress={onPress}
      onHoverIn={hoverIn}
      onHoverOut={hoverOut}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={
        {
          height: SIDEBAR_ROW_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "flex-start",
          paddingLeft: collapsed ? 0 : 14,
          paddingRight: collapsed ? 0 : 10,
          borderRadius: radius.sm,
          backgroundColor: background,
          ...(Platform.OS === "web"
            ? {
                // A nav row is a link; react-native-web leaves a Pressable as
                // `cursor: auto`.
                cursor: "pointer",
                ...webFocusRing(showRing, accentName),
              }
            : null),
        } as ViewStyle
      }
    >
      {active ? (
        // The "you are here" bar. Inside the row rather than at the sidebar's
        // edge so it lines up with the fill it belongs to, and absolute so it
        // costs the label no width on the rail.
        <View
          style={{
            position: "absolute",
            left: 0,
            top: 8,
            bottom: 8,
            width: 3,
            borderRadius: 2,
            backgroundColor: accent[500],
          }}
        />
      ) : null}

      {item.icon.set === "semantic" ? (
        <Icon name={item.icon.name} size={20} color={glyphColor} />
      ) : (
        <Ionicons name={item.icon.name} size={20} color={glyphColor} />
      )}

      {collapsed ? null : (
        <Text
          variant='body'
          tone={tone}
          weight={active ? "semibold" : "regular"}
          numberOfLines={1}
          style={{ marginLeft: 12, flexShrink: 1 }}
        >
          {item.label}
        </Text>
      )}
    </Pressable>
  );
};

/**
 * The rail's label, on hover, drawn by `Sidebar` at the hovered row's height.
 *
 * A real DOM `title` would be simpler, but react-native-web has no prop that
 * maps to one — `accessibilityLabel` becomes `aria-label`, which a screen
 * reader announces and a pointer never shows. Drawing our own also lets it use
 * the app's type and surfaces rather than the browser's.
 */
export const RailTooltip: React.FC<{ label: string; top: number }> = ({
  label,
  top,
}) => (
  <View
    // Purely decorative: the row it belongs to already carries the same string
    // as its accessible name.
    pointerEvents='none'
    style={{
      position: "absolute",
      left: 60,
      top,
      // An absolutely positioned box shrinks to fit inside its containing
      // block, and the rail's containing block is 72 px wide — which left 12 px
      // for the label and rendered an 8 px sliver. The width has to be stated.
      minWidth: 120,
      maxWidth: 220,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: tokens.color.border.subtle,
      backgroundColor: tokens.color.bg["2"],
      zIndex: 20,
    }}
  >
    <Text variant='caption' numberOfLines={1}>
      {label}
    </Text>
  </View>
);
