import { View } from "react-native";
import { useTheme } from "@/hooks/useTheme";

interface Props {
  index: number;
}
// Dev note might be a good idea to standardize skeletons across the app and have one "file" for it.
export const GridSkeleton: React.FC<Props> = ({ index }) => {
  const { color } = useTheme();
  return (
    <View
      key={index}
      className='flex flex-col mr-2 h-auto'
      style={{ width: "30.5%" }}
    >
      <View
        style={{
          borderColor: color.border.subtle,
          backgroundColor: color.bg["2"],
        }}
        className='relative rounded-lg overflow-hidden border w-full mt-4 aspect-[10/15]'
      />
      <View className='mt-2 flex flex-col w-full'>
        <View
          style={{ backgroundColor: color.bg["2"] }}
          className='h-4 rounded mb-1'
        />
        <View
          style={{ backgroundColor: color.bg["2"] }}
          className='h-3 rounded w-1/2'
        />
      </View>
    </View>
  );
};
