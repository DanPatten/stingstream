import { Platform, Switch as RNSwitch, type SwitchProps } from "react-native";
import { fade, interaction } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";

/**
 * The toggle, in the app's colors.
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
 * The thumb stays white-ish in both states. A thumb that changes color with
 * the track reads as two controls rather than one moving part.
 *
 * **Web needs its own two props.** react-native-web's `Switch` reads
 * `activeTrackColor`/`activeThumbColor` for the on state and ignores
 * `trackColor.true` entirely, so every toggle in the browser was painted in
 * RNW's own default — Material teal `#009688`. That went unnoticed while the
 * app's accent was itself a teal; the moment the accent became the mark's cyan
 * it read as a stray color from another product. They are not React Native
 * props, so they are spread only on web.
 */
export const Switch: React.FC<SwitchProps> = ({
  disabled,
  value,
  style,
  ...props
}) => {
  const { color, accent } = useTheme();
  const on = disabled
    ? fade(accent[500], interaction.disabledFillAlpha)
    : accent[500];
  const off = color.bg["3"];
  const thumb = disabled
    ? fade(color.text.primary, interaction.disabledLabelAlpha)
    : color.text.primary;
  const webTrack =
    Platform.OS === "web"
      ? ({ activeTrackColor: on, activeThumbColor: thumb } as object)
      : null;

  return (
    <RNSwitch
      value={value}
      disabled={disabled}
      trackColor={{ false: off, true: on }}
      thumbColor={thumb}
      {...webTrack}
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
