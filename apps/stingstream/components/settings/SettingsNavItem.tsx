import { useState } from "react";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import type { SettingsCategory } from "@/components/shell/buildSettingsCategories";
import { radius, tokens, webFocusRing } from "@/constants/theme";
import { useFocusVisible } from "@/hooks/useFocusVisible";
import { useTheme } from "@/hooks/useTheme";

/**
 * One row of the settings category column.
 *
 * Deliberately the same three states, drawn the same way, as
 * `components/shell/SidebarItem.tsx`: *where you are* (an accent bar and a
 * lighter fill), *what you are pointing at* (fill only), and *what the keyboard
 * is on* (the accent outline, gated on `useFocusVisible` so a click does not
 * leave a ring around a row that already has a bar and a fill).
 *
 * It is not that component, though, and the reason is the second line. A
 * sidebar row is one word at a fixed 40 px; a category row carries a sentence
 * saying what is inside, because that sentence is the whole point of the
 * restructure — it is what replaced *Server settings* listing its own six
 * sub-pages as a subtitle.
 */
export const SettingsNavItem: React.FC<{
  category: SettingsCategory;
  active: boolean;
  onPress: () => void;
}> = ({ category, active, onPress }) => {
  const { accentName, accent } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showRing = useFocusVisible(focused);

  const glyphColor = active ? accent[500] : tokens.color.text.secondary;

  return (
    <Pressable
      testID={category.testID}
      accessibilityRole='link'
      accessibilityLabel={category.label}
      accessibilityState={{ selected: active }}
      // `aria-current="page"` is the right mark-up for "this is the row you are
      // on", and react-native-web passes it straight through — but React
      // Native's own prop types have never had it, so it goes in as a spread.
      {...(active ? ({ "aria-current": "page" } as object) : null)}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={
        {
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 10,
          paddingVertical: 8,
          paddingLeft: 12,
          paddingRight: 10,
          marginBottom: 2,
          borderRadius: radius.sm,
          backgroundColor:
            active || hovered ? tokens.color.bg["3"] : "transparent",
          ...(Platform.OS === "web"
            ? { cursor: "pointer", ...webFocusRing(showRing, accentName) }
            : null),
        } as ViewStyle
      }
    >
      {active ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            top: 6,
            bottom: 6,
            width: 3,
            borderRadius: 2,
            backgroundColor: accent[500],
          }}
        />
      ) : null}

      {/* Nudged down to sit on the label's cap height rather than between the
          two lines of text. */}
      <View style={{ paddingTop: 2 }}>
        <Icon name={category.icon} size={18} color={glyphColor} />
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        {/* Two lines rather than an ellipsis: "Network & remote access" and
            "Movie & series managers" both lose their last word at one line, and
            a navigation row whose label has to be guessed is not one. */}
        <Text
          variant='body'
          tone={active ? "primary" : "secondary"}
          weight={active ? "semibold" : "regular"}
          numberOfLines={2}
        >
          {category.label}
        </Text>
        {/* Two lines, then an ellipsis. The hint is an orientation aid, not the
            page — a row that grows to five lines stops being scannable, which
            is the failure the old one-line-per-row list had in the other
            direction. */}
        <Text variant='micro' tone='tertiary' numberOfLines={2}>
          {category.detail}
        </Text>
      </View>
    </Pressable>
  );
};
