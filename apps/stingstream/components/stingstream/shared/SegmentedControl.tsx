import { ScrollView, TouchableOpacity, View } from "react-native";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";

interface Segment {
  key: string;
  label: string;
}

/**
 * A row of pill buttons for switching between sections within one screen
 * (Manage's Movies/Series/Calendar/Activity, Admin's Users/Libraries/...).
 * Plain local-state navigation rather than a nested router stack or
 * `@react-navigation/material-top-tabs` — these are flat, same-depth
 * sections, not independently deep-linkable screens.
 */
export function SegmentedControl({
  segments,
  value,
  onChange,
}: {
  segments: Segment[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
      className='flex-none'
    >
      {segments.map((segment) => {
        const active = segment.key === value;
        return (
          <TouchableOpacity
            key={segment.key}
            onPress={() => onChange(segment.key)}
            className='rounded-full px-4 py-2'
            style={{
              backgroundColor: active ? Colors.primary : "#1f1f1f",
            }}
          >
            <Text
              className={active ? "text-white font-semibold" : "text-[#9899A1]"}
            >
              {segment.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

/** Thin top strip so screens don't each re-derive this padding. */
export function SegmentedControlBar(props: {
  segments: Segment[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <View className='py-3 bg-[#151718]'>
      <SegmentedControl {...props} />
    </View>
  );
}
