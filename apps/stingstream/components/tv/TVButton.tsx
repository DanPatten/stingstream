import React from "react";
import { Animated, Pressable, View, type ViewStyle } from "react-native";
import { scaleSize } from "@/utils/scaleSize";
import { useTVFocusAnimation } from "./hooks/useTVFocusAnimation";

export interface TVButtonProps {
  onPress: () => void;
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "glass";
  hasTVPreferredFocus?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  scaleAmount?: number;
  square?: boolean;
  refSetter?: (ref: View | null) => void;
  nextFocusDown?: number;
  nextFocusUp?: number;
  /**
   * Floor for the button's painted height.
   *
   * A row mixing text buttons and square icon buttons ends up ragged, because
   * this component sizes itself from its padding and an icon is taller than a
   * line of callout text. Give every button in one row the same `minHeight`
   * and the row reads as a single control strip -- which is the rule in
   * docs/conventions/tv.md, not a preference.
   */
  minHeight?: number;
}

const getButtonStyles = (
  variant: "primary" | "secondary" | "glass",
  focused: boolean,
) => {
  switch (variant) {
    case "glass":
      return {
        // Constant border width, color swaps only — toggling width would
        // relayout the row on every focus move.
        backgroundColor: focused
          ? "rgba(255, 255, 255, 0.25)"
          : "rgba(255, 255, 255, 0.1)",
        borderWidth: scaleSize(2),
        borderColor: focused
          ? "rgba(255, 255, 255, 0.9)"
          : "rgba(255, 255, 255, 0)",
      };
    case "secondary":
      return {
        backgroundColor: focused
          ? "rgba(255, 255, 255, 0.3)"
          : "rgba(255, 255, 255, 0.15)",
        borderWidth: scaleSize(2),
        borderColor: focused
          ? "rgba(255, 255, 255, 0.9)"
          : "rgba(255, 255, 255, 0)",
      };
    default:
      // The fill itself must signal focus: a white-on-white border ring is
      // invisible on this solid fill, and Android TV devices don't reliably
      // render the iOS glow, so dim the resting fill and go fully opaque +
      // glow when focused.
      return {
        backgroundColor: focused ? "#ffffff" : "rgba(255, 255, 255, 0.7)",
        borderWidth: 0,
        borderColor: "transparent",
      };
  }
};

export const TVButton: React.FC<TVButtonProps> = ({
  onPress,
  children,
  variant = "primary",
  hasTVPreferredFocus = false,
  disabled = false,
  style,
  scaleAmount = 1.04,
  square = false,
  refSetter,
  nextFocusDown,
  nextFocusUp,
  minHeight,
}) => {
  const { focused, handleFocus, handleBlur, animatedStyle } =
    useTVFocusAnimation({ scaleAmount });

  const buttonStyles = getButtonStyles(variant, focused);

  return (
    <Pressable
      ref={refSetter}
      onPress={onPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      hasTVPreferredFocus={hasTVPreferredFocus && !disabled}
      disabled={disabled}
      focusable={!disabled}
      nextFocusDown={nextFocusDown}
      nextFocusUp={nextFocusUp}
    >
      <Animated.View style={[animatedStyle, style]}>
        <View
          style={{
            backgroundColor: buttonStyles.backgroundColor,
            borderWidth: buttonStyles.borderWidth,
            borderColor: buttonStyles.borderColor,
            borderRadius: scaleSize(12),
            minHeight,
            paddingVertical: scaleSize(18),
            paddingHorizontal: square ? scaleSize(18) : scaleSize(32),
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            minWidth: square ? undefined : scaleSize(180),
            // tvOS-only centered glow. Do NOT add elevation for Android: it
            // renders as an offset drop shadow *outside* the button (a
            // detached glow blob), and shadowOpacity/shadowRadius are iOS
            // props. Android TV's focus signal is the fill/border swap plus
            // the scale animation, matching leanback conventions.
            shadowColor: "#fff",
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: focused ? 0.5 : 0,
            shadowRadius: focused ? scaleSize(15) : 0,
          }}
        >
          {children}
        </View>
      </Animated.View>
    </Pressable>
  );
};
