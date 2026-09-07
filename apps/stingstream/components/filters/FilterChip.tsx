import { useState } from "react";
import {
  Platform,
  Pressable,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Icon, type IconName } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { motion, radius, tokens, webFocusRing } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";

export interface FilterChipProps {
  label: string;
  icon?: IconName;
  /**
   * This filter is narrowing the list. An active chip is *filled*, not tinted:
   * a bar of six tinted chips reads as decoration, and "which of these am I
   * actually using" is the one question the bar has to answer at a glance.
   */
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
  /** Defaults to the label. Pass one when the label alone is ambiguous. */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  /** For the screens whose own bar still spaces its chips with a utility class. */
  className?: string;
}

const isWeb = Platform.OS === "web";

/**
 * One chip in a filter/sort bar.
 *
 * `Pill` is the same shape but is a static display component with no press
 * handling, so this borrows its geometry rather than wrapping it in a second
 * touchable — the nested-pressable version swallowed presses near the chip's
 * edge.
 *
 * 40 px tall on purpose: the bar is the first thing a thumb reaches for on a
 * phone, and a 32 px chip is under every touch-target guideline there is.
 */
export const FilterChip: React.FC<FilterChipProps> = ({
  label,
  icon,
  active = false,
  disabled = false,
  onPress,
  accessibilityLabel,
  style,
  className,
}) => {
  const { accent } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  const background = active
    ? accent[500]
    : hovered && isWeb
      ? tokens.color.bg["3"]
      : tokens.color.bg["2"];

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole='button'
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: active, disabled }}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={className}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          minHeight: 40,
          paddingHorizontal: 14,
          borderRadius: radius.pill,
          backgroundColor: background,
          opacity: disabled ? 0.5 : 1,
        },
        isWeb
          ? ({
              cursor: disabled ? "default" : "pointer",
              transitionDuration: `${motion.fast}ms`,
              ...webFocusRing(focused),
            } as ViewStyle)
          : null,
        style,
      ]}
    >
      <Text
        variant='caption'
        weight='semibold'
        tone={active ? "onAccent" : "secondary"}
        numberOfLines={1}
      >
        {label}
      </Text>
      {icon ? (
        <Icon name={icon} size={14} tone={active ? "onAccent" : "secondary"} />
      ) : null}
    </Pressable>
  );
};
