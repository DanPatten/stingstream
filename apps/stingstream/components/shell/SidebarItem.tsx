import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, tokens, webFocusRing } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import type { SidebarItem as SidebarItemModel } from "./buildSidebarItems";

export const SIDEBAR_ROW_HEIGHT = 40;

interface Props {
  item: SidebarItemModel;
  active: boolean;
  /** The 72 px icon rail (medium widths): glyph only, label on hover. */
  collapsed: boolean;
  onPress: () => void;
}

/**
 * One row of the sidebar.
 *
 * Three states have to be legible at a glance and never at the same time:
 * *where you are* (an accent bar and a lighter fill), *what you are pointing
 * at* (fill only), and *what the keyboard is on* (the accent outline). The
 * pointer and keyboard ones are separate because they are separate on the web —
 * tabbing through the sidebar with the mouse parked over Favorites must not
 * look like two selections.
 */
export const SidebarItem: React.FC<Props> = ({
  item,
  active,
  collapsed,
  onPress,
}) => {
  const { accentName, accent } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  const background = active || hovered ? tokens.color.bg["3"] : "transparent";
  const tone = active ? "primary" : "secondary";
  const glyphColor = active ? accent[500] : tokens.color.text.secondary;

  return (
    <View>
      <Pressable
        testID={item.testID}
        accessibilityRole='link'
        accessibilityLabel={item.label}
        accessibilityState={{ selected: active }}
        onPress={onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
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
                  // A nav row is a link; react-native-web leaves a Pressable
                  // as `cursor: auto`.
                  cursor: "pointer",
                  ...webFocusRing(focused, accentName),
                }
              : null),
          } as ViewStyle
        }
      >
        {active ? (
          // The "you are here" bar. Inside the row rather than at the
          // sidebar's edge so it lines up with the fill it belongs to, and
          // absolute so it costs the label no width on the rail.
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

      {collapsed && hovered ? <RailTooltip label={item.label} /> : null}
    </View>
  );
};

/**
 * The rail's label, on hover.
 *
 * A real DOM `title` would be simpler, but react-native-web has no prop that
 * maps to one — `accessibilityLabel` becomes `aria-label`, which a screen
 * reader announces and a pointer never shows. So the rail draws its own, which
 * also lets it use the app's own type and surface rather than the browser's.
 */
const RailTooltip: React.FC<{ label: string }> = ({ label }) => (
  <View
    // Purely decorative: the row it belongs to already carries the same string
    // as its accessible name.
    pointerEvents='none'
    style={{
      position: "absolute",
      left: 56,
      top: 6,
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
