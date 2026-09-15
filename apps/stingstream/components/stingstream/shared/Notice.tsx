import { View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, rgba, space } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";

/**
 * A one-line warning at the top of a dialog or section.
 *
 * Dan, on the account dialog's footnote about locked accounts: it *"should be a warning banner at
 * the top"*. A caption under the controls is read after somebody has already tried the greyed-out
 * button; a banner above them is read first.
 */
export function Notice({ text, testID }: { text: string; testID?: string }) {
  const { color } = useTheme();
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space["3"],
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: radius.lg,
        backgroundColor: rgba(color.state.warning, 0.12),
      }}
    >
      <Icon name='warning' size={18} color={color.state.warning} />
      <Text variant='caption' style={{ flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}
