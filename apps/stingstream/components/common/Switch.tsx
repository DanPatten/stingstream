import { Platform, Switch as RNSwitch, type SwitchProps } from "react-native";
import { fade, interaction, tokens } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";

/**
 * The toggle, in the app's colours.
 *
 * React Native's `Switch` defaults to the platform's own accent — iOS system
 * green, Android's Material purple — which is how a teal app ended up with a
 * row of green and violet toggles down its settings screens. `trackColor`,
 * `thumbColor` and `ios_backgroundColor` are the three props it takes to draw
 * one properly, and all three have to be set together: give it only
 * `trackColor.true` and the off state stays platform grey, and omit
 * `ios_backgroundColor` and iOS paints its own off-track behind the rounded
 * corners while the switch animates.
 *
 * The thumb stays white-ish in both states. A thumb that changes colour with
 * the track reads as two controls rather than one moving part.
 */
export const Switch: React.FC<SwitchProps> = ({
  disabled,
  value,
  style,
  ...props
}) => {
  const { accent } = useTheme();
  const on = disabled
    ? fade(accent[500], interaction.disabledFillAlpha)
    : accent[500];
  const off = tokens.color.bg["3"];

  return (
    <RNSwitch
      value={value}
      disabled={disabled}
      trackColor={{ false: off, true: on }}
      thumbColor={
        disabled
          ? fade(tokens.color.text.primary, interaction.disabledLabelAlpha)
          : tokens.color.text.primary
      }
      // iOS draws this behind the track while the thumb travels; without it the
      // off state flashes the system grey mid-animation.
      ios_backgroundColor={off}
      style={[
        Platform.OS === "web"
          ? ({ cursor: disabled ? "not-allowed" : "pointer" } as object)
          : null,
        style,
      ]}
      {...props}
    />
  );
};
