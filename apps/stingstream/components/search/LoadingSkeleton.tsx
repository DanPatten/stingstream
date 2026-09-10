import { View } from "react-native";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "@/hooks/useTheme";
import { Text } from "../common/Text";

interface Props {
  isLoading: boolean;
}

export const LoadingSkeleton: React.FC<Props> = ({ isLoading }) => {
  const { color } = useTheme();
  const opacity = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => {
    return {
      opacity: opacity.value,
    };
  });

  useAnimatedReaction(
    () => isLoading,
    (loading) => {
      if (loading) {
        opacity.value = withTiming(1, { duration: 200 });
      } else {
        opacity.value = withTiming(0, { duration: 200 });
      }
    },
  );

  return (
    <Animated.View style={animatedStyle} className='mt-2 absolute w-full'>
      {[1, 2, 3].map((s) => (
        <View className='px-4 mb-4' key={s}>
          <View
            style={{ backgroundColor: color.bg["1"] }}
            className='w-1/2 h-6 mb-2 rounded-lg'
          />
          <View className='flex flex-row gap-2'>
            {[1, 2, 3].map((i) => (
              <View className='w-28' key={i}>
                <View
                  style={{ backgroundColor: color.bg["1"] }}
                  className='h-40 w-full rounded-md mb-1'
                />
                <View className='rounded-md overflow-hidden mb-1 self-start'>
                  <Text
                    style={{
                      backgroundColor: color.bg["1"],
                      color: color.bg["0"],
                    }}
                    className='rounded-md'
                    numberOfLines={1}
                  >
                    Nisi mollit voluptate amet.
                  </Text>
                </View>
                <View className='rounded-md overflow-hidden self-start mb-1'>
                  <Text
                    style={{
                      backgroundColor: color.bg["1"],
                      color: color.bg["0"],
                    }}
                    className='text-xs rounded-md'
                    numberOfLines={1}
                  >
                    Lorem ipsum
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ))}
    </Animated.View>
  );
};
