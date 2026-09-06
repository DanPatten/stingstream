import React, { useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  View,
  type ViewStyle,
} from "react-native";
import { TV_FOCUS } from "@/constants/TVCardLayouts";

export interface TVFocusablePosterProps {
  children: React.ReactNode;
  onPress: () => void;
  onLongPress?: () => void;
  hasTVPreferredFocus?: boolean;
  scaleAmount?: number;
  style?: ViewStyle;
  onFocus?: () => void;
  onBlur?: () => void;
  disabled?: boolean;
  /** When true, the item remains focusable even when disabled (for navigation purposes) */
  focusableWhenDisabled?: boolean;
  /** Setter function for the ref (for focus guide destinations) */
  refSetter?: (ref: View | null) => void;
}

export const TVFocusablePoster: React.FC<TVFocusablePosterProps> = ({
  children,
  onPress,
  onLongPress,
  hasTVPreferredFocus = false,
  scaleAmount = TV_FOCUS.scale,
  style,
  onFocus: onFocusProp,
  onBlur: onBlurProp,
  disabled = false,
  focusableWhenDisabled = false,
  refSetter,
}) => {
  const [focused, setFocused] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;

  const animateTo = (value: number) =>
    Animated.timing(scale, {
      toValue: value,
      duration: TV_FOCUS.durationMs,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();

  return (
    <Pressable
      ref={refSetter}
      onPress={onPress}
      onLongPress={onLongPress}
      onFocus={() => {
        setFocused(true);
        animateTo(scaleAmount);
        onFocusProp?.();
      }}
      onBlur={() => {
        setFocused(false);
        animateTo(1);
        onBlurProp?.();
      }}
      hasTVPreferredFocus={hasTVPreferredFocus && !disabled}
      disabled={disabled}
      focusable={!disabled || focusableWhenDisabled}
    >
      <Animated.View
        style={[
          {
            transform: [{ scale }],
            // Focus is white on TV, never the accent. See docs/conventions/tv.md.
            shadowColor: TV_FOCUS.borderColor,
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: focused ? TV_FOCUS.glowOpacity : 0,
            shadowRadius: focused ? TV_FOCUS.glowRadius : 0,
          },
          style,
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
};
