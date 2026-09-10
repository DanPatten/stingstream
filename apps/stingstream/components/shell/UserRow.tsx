import { useAtomValue } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Text } from "@/components/common/Text";
import { radius, webFocusRing } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useFocusVisible } from "@/hooks/useFocusVisible";
import { useTheme } from "@/hooks/useTheme";
import { userAtom } from "@/providers/JellyfinProvider";

const AVATAR_SIZE = 32;

interface Props {
  /** The sidebar rail draws the avatar alone. */
  collapsed?: boolean;
}

/**
 * Who you are signed in as, at the foot of the sidebar. Press it to open your
 * profile.
 *
 * A row that navigates, not a popover. The card this replaced held one
 * destination and a sign-out, and both live on the profile screen anyway: a
 * menu whose every entry is on the page it leads to is a step, not a shortcut.
 */
export const UserRow: React.FC<Props> = ({ collapsed = false }) => {
  const { t } = useTranslation();
  const user = useAtomValue(userAtom);
  const { accent, color } = useTheme();
  const router = useRouter();

  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showRing = useFocusVisible(focused);

  const name = user?.Name ?? "";

  // `navigate`, not `push`. `useAppRouter`'s `push` is gated by a ref that only
  // resets when the calling *screen* regains focus, and the sidebar is not a
  // screen: it lives outside the navigator and never blurs, so every push from
  // it after the first is dropped in silence. The rows above this one navigate
  // for the same reason (see `WebShellLayout.onSelect`), and `navigate` reuses
  // the profile route rather than stacking a second copy of it.
  const openProfile = useCallback(() => {
    router.navigate("/settings/profile");
  }, [router]);

  return (
    <Pressable
      testID='shell-user-menu'
      accessibilityRole='button'
      accessibilityLabel={name || t("shell.account")}
      onPress={openProfile}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={
        {
          flexDirection: "row",
          alignItems: "center",
          borderRadius: radius.sm,
          paddingVertical: 4,
          paddingHorizontal: collapsed ? 4 : 8,
          backgroundColor: hovered ? color.bg["3"] : "transparent",
          ...(Platform.OS === "web"
            ? { cursor: "pointer", ...webFocusRing(showRing, color) }
            : null),
        } as ViewStyle
      }
    >
      <Avatar name={name} color={accent[500]} />
      {collapsed ? null : (
        <Text
          variant='caption'
          weight='medium'
          numberOfLines={1}
          style={{ marginLeft: 10, flex: 1 }}
        >
          {name}
        </Text>
      )}
    </Pressable>
  );
};

/** Initials on the accent — no avatar image, so no request and no broken box. */
const Avatar: React.FC<{ name: string; color: string }> = ({ name, color }) => (
  <View
    style={{
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      borderRadius: AVATAR_SIZE / 2,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: color,
    }}
  >
    <Text variant='caption' weight='bold' tone='onAccent'>
      {initials(name)}
    </Text>
  </View>
);

/** "Dan Patten" -> "DP", "dan" -> "D", "" -> "?". */
const initials = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
};
