import { View } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { Text } from "../common/Text";

export const HourHeader = ({ height }: { height: number }) => {
  const now = new Date();
  const currentHour = now.getHours();
  const hoursRemaining = 24 - currentHour;
  const hours = generateHours(currentHour, hoursRemaining);

  return (
    <View
      className='flex flex-row'
      style={{
        height,
      }}
    >
      {hours.map((hour, index) => (
        <HourCell key={index} hour={hour} />
      ))}
    </View>
  );
};

const HourCell = ({ hour }: { hour: Date }) => {
  const { color } = useTheme();

  return (
    <View
      style={{ backgroundColor: color.bg["2"] }}
      className='w-[200px] flex items-center justify-center'
    >
      <Text tone='tertiary' className='text-xs'>
        {hour.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </Text>
    </View>
  );
};

const generateHours = (startHour: number, count: number): Date[] => {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const hour = new Date(now);
    hour.setHours(startHour + i, 0, 0, 0);
    return hour;
  });
};
