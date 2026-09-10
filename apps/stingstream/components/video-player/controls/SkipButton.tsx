import type React from "react";
import { TouchableOpacity, View, type ViewProps } from "react-native";
import { Text } from "@/components/common/Text";
import { rgba } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { PLAYER_PALETTE } from "./constants";

interface SkipButtonProps extends ViewProps {
  onPress: () => void;
  showButton: boolean;
  buttonText: string;
}

const SkipButton: React.FC<SkipButtonProps> = ({
  onPress,
  showButton,
  buttonText,
  ...props
}) => {
  const { color } = useTheme();
  return (
    <View className={showButton ? "flex" : "hidden"} {...props}>
      <TouchableOpacity
        onPress={onPress}
        // Over video, so the chip is dark on every theme.
        style={{
          backgroundColor: rgba(PLAYER_PALETTE.bg["0"], 0.6),
          borderColor: PLAYER_PALETTE.border.subtle,
        }}
        className='rounded-md px-3 py-2 border'
      >
        <Text className='text-sm font-bold'>{buttonText}</Text>
      </TouchableOpacity>
    </View>
  );
};

export default SkipButton;
