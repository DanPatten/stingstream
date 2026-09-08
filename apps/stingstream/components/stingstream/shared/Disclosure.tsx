import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";

/**
 * A heading that folds away what is under it.
 *
 * For the settings nobody should meet unless they went looking: an address that already has a
 * sensible value, a way out of a group. Collapsed by default, because a screen that opens with its
 * rare controls on show reads as a screen full of decisions.
 *
 * Lifted out of `GroupDetailScreen`, where it was local, once the Sharing screen wanted the same
 * thing for its Advanced section.
 */
export function Disclosure({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <View>
      <Pressable
        accessibilityRole='button'
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: 12,
          },
          Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null,
        ]}
      >
        <Text variant='heading' weight='semibold'>
          {title}
        </Text>
        <Icon
          name={open ? "chevronUp" : "chevronDown"}
          size={18}
          tone='secondary'
        />
      </Pressable>
      {open && <View>{children}</View>}
    </View>
  );
}
