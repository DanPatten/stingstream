import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { GapNotice } from "../shared/GapNotice";

export function CalendarSection() {
  return (
    <View>
      <Text className='text-white text-lg font-semibold mb-2'>Calendar</Text>
      <GapNotice
        title="Calendar isn't available yet"
        detail="StingStream.Core doesn't publish upcoming episodes/releases yet — see docs/UI-API-GAPS.md for the proposed endpoint. Radarr and Sonarr both track this internally already."
      />
    </View>
  );
}
