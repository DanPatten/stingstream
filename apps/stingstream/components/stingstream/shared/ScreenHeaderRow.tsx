import type { ReactNode } from "react";
import { View } from "react-native";
import { Text } from "@/components/common/Text";

/**
 * The "<Title>  ...action" row every StingStream section opens with.
 *
 * Unlike `components/common/SectionHeader`, this adds no gutter of its own —
 * every screen in this package already sits inside `RefreshScreen`'s
 * `PageContainer`, so a second `paddingHorizontal` here would double it. Kept
 * as its own component anyway, rather than repeating the row in every
 * section, so the spacing and heading style stay in one place.
 */
export function ScreenHeaderRow({
  title,
  accessory,
}: {
  /** Omitted when the page title above already names the section, so it is not said twice. */
  title?: string;
  accessory?: ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: title ? "space-between" : "flex-end",
        marginBottom: 12,
      }}
    >
      {title ? (
        <Text variant='heading' weight='semibold' style={{ flexShrink: 1 }}>
          {title}
        </Text>
      ) : null}
      {accessory}
    </View>
  );
}
