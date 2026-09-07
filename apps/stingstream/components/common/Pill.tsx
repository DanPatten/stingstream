import { Pressable, type StyleProp, View, type ViewStyle } from "react-native";
import { fade, interaction, radius, rgba, tokens } from "@/constants/theme";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useTheme } from "@/hooks/useTheme";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";

export type PillTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";

export interface PillProps {
  label: string;
  /** What the state *is*. Colour follows from it. */
  tone?: PillTone;
  icon?: IconName;
  /** `soft` is a tinted chip; `solid` is a filled badge for the loud cases. */
  emphasis?: "soft" | "solid";
  size?: "sm" | "md";
  /**
   * Makes the pill a control: a filter chip, a removable tag. It then gets the
   * hover, pressed and focus states every other control has, and a button role.
   * Without it a pill is a label and stays inert under the pointer.
   */
  onPress?: () => void;
  disabled?: boolean;
  /** Screen-reader label when `label` alone is not the whole story. */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * A small piece of state next to the thing it describes: "Syncing", "4K",
 * "Requested", "Offline" — or, with `onPress`, a filter chip.
 *
 * Tinted rather than filled by default: a screen with six saturated badges on
 * it reads as an error page. `solid` exists for the two or three that genuinely
 * need to shout.
 */
export const Pill: React.FC<PillProps> = ({
  label,
  tone = "neutral",
  icon,
  emphasis = "soft",
  size = "md",
  onPress,
  disabled = false,
  accessibilityLabel,
  style,
}) => {
  const { accent } = useTheme();
  const states = usePressableStates({ disabled });
  const base =
    tone === "accent" ? accent[500] : tone === "neutral" ? null : TONES[tone];
  const solid = emphasis === "solid" && base !== null;

  const restBackground = solid
    ? base
    : base
      ? rgba(base, 0.16)
      : tokens.color.bg["3"];
  const foreground = solid
    ? tokens.color.bg["0"]
    : (base ?? tokens.color.text.secondary);

  const box: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingHorizontal: size === "sm" ? 6 : 8,
    paddingVertical: size === "sm" ? 2 : 3,
    borderRadius: radius.pill,
    backgroundColor: restBackground,
    opacity: disabled ? tokens.control.disabledOpacity : 1,
  };

  const content = (
    <>
      {/* The hover/pressed wash sits *over* the pill's own fill rather than
          replacing it, so one pair of alphas covers all six tones and both
          emphases without a lookup table per combination. */}
      {onPress && states.overlay ? (
        <View
          pointerEvents='none'
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderRadius: radius.pill,
            backgroundColor: states.overlay,
          }}
        />
      ) : null}
      {icon ? (
        <Icon
          name={icon}
          size={size === "sm" ? 11 : 13}
          color={
            disabled
              ? fade(foreground, interaction.disabledLabelAlpha)
              : foreground
          }
          style={{ marginRight: 4 }}
        />
      ) : null}
      <Text
        variant={size === "sm" ? "micro" : "caption"}
        weight='semibold'
        style={{
          color: disabled
            ? fade(foreground, interaction.disabledLabelAlpha)
            : foreground,
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </>
  );

  if (!onPress) {
    return <View style={[box, style]}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      {...states.handlers}
      style={[box, { overflow: "hidden" }, states.webStyle, style]}
    >
      {content}
    </Pressable>
  );
};

const TONES: Record<Exclude<PillTone, "neutral" | "accent">, string> = {
  success: tokens.color.state.success,
  warning: tokens.color.state.warning,
  danger: tokens.color.state.danger,
  info: tokens.color.state.info,
};
