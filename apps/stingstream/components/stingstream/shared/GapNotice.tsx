import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";
import { Text } from "@/components/common/Text";

/**
 * Rendered in place of a section StingStream.Core does not expose an
 * endpoint for yet. Every use of this component has a matching entry in
 * docs/UI-API-GAPS.md — keep them in sync.
 */
export function GapNotice({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <View className='rounded-xl bg-neutral-900 p-4 items-center'>
      <Ionicons name='construct-outline' size={22} color='#9899A1' />
      <Text className='text-white font-semibold mt-2 text-center'>{title}</Text>
      <Text className='text-[#9899A1] text-xs text-center mt-1'>{detail}</Text>
    </View>
  );
}
