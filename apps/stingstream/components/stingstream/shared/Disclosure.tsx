import { useEffect, useState } from "react";
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
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  /**
   * Start open, or open when this becomes true.
   *
   * Collapsed-by-default is right for a section nobody should meet unless they went looking, and
   * wrong for somebody who was *sent* here: a minted invite that only works at home offers "set up
   * a domain", and landing on the right screen with the field still folded away is the same dead
   * end with an extra step. It stays uncontrolled otherwise — this only ever opens it, so a
   * deliberate collapse afterwards is not fought.
   */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

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
