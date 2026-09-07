import { View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";

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
    <View
      style={{
        borderRadius: radius.md,
        backgroundColor: tokens.color.bg["1"],
        padding: 16,
        alignItems: "center",
      }}
    >
      <Icon name='info' size={22} tone='secondary' />
      <Text
        variant='body'
        weight='semibold'
        align='center'
        style={{ marginTop: 8 }}
      >
        {title}
      </Text>
      <Text
        variant='caption'
        tone='secondary'
        align='center'
        style={{ marginTop: 4 }}
      >
        {detail}
      </Text>
    </View>
  );
}
