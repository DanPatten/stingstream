import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, TouchableOpacity, View } from "react-native";
import { useHaptic } from "@/hooks/useHaptic";
import { ICON_SIZES } from "./constants";

interface ZoomToggleProps {
  isZoomedToFill: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export const ZoomToggle: React.FC<ZoomToggleProps> = ({
  isZoomedToFill,
  onToggle,
  disabled = false,
}) => {
  const lightHapticFeedback = useHaptic("light");

  const handlePress = () => {
    if (disabled) return;
    lightHapticFeedback();
    onToggle();
  };

  // Hide on TV platforms
  if (Platform.isTV) return null;

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={disabled}
      style={styles.button}
    >
      <View style={{ opacity: disabled ? 0.5 : 1 }}>
        {/* "Crop", not "expand": this fills the *frame* by cropping the picture, and the
            neighbouring web-only button that fills the *window* was drawing the same two
            glyphs. */}
        <Ionicons
          name={isZoomedToFill ? "crop" : "crop-outline"}
          size={ICON_SIZES.HEADER}
          color='white'
        />
      </View>
    </TouchableOpacity>
  );
};

// Inline, like the rest of the OSD: NativeWind's classes do not apply in the web bundle.
const styles = StyleSheet.create({
  button: {
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    padding: 8,
    marginLeft: 4,
  },
});
