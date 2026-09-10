import type React from "react";
import { TouchableOpacity, View, type ViewProps } from "react-native";
import { Text } from "@/components/common/Text";
import { useTheme } from "@/hooks/useTheme";

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
        style={{ borderColor: color.border.subtle }}
        onPress={onPress}
        className='bg-black/60 rounded-md px-3 py-2 border'
      >
        <Text className='text-sm font-bold'>{buttonText}</Text>
      </TouchableOpacity>
    </View>
  );
};

export default SkipButton;
