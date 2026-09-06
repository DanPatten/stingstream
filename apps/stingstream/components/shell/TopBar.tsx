import { useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, tokens, webFocusRing } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useSessions, type useSessionsProps } from "@/hooks/useSessions";
import { useTheme } from "@/hooks/useTheme";
import { userAtom } from "@/providers/JellyfinProvider";
import { SearchField } from "./SearchField";
import { UserMenu } from "./UserMenu";
import { useScreenTitle } from "./useScreenTitle";

export const TOP_BAR_HEIGHT = 56;

interface Props {
  /** The active sidebar row's label, used when no screen has claimed a title. */
  fallbackTitle: string;
}

/**
 * The bar across the top of every desktop screen.
 *
 * It is where the tab-root headers went. Hiding those and drawing one bar is
 * what stops a browser window looking like a phone in a frame: the page says
 * what it is once, in one place, and search and the account are always in the
 * same spot rather than three glyphs in a native header that changes per tab.
 *
 * The Home tab's own header buttons live here now — Sessions on the right, and
 * Settings and Sign out inside the account menu. Chromecast is not among them:
 * it has no web implementation at all (`docs/M2-web-spike.md` §7).
 */
export const TopBar: React.FC<Props> = ({ fallbackTitle }) => {
  const user = useAtomValue(userAtom);
  const screenTitle = useScreenTitle();
  const isAdmin = Boolean(user?.Policy?.IsAdministrator);

  return (
    <View
      testID='shell-topbar'
      style={{
        height: TOP_BAR_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 20,
        gap: 16,
        backgroundColor: tokens.color.bg["0"],
        borderBottomWidth: 1,
        borderBottomColor: tokens.color.border.subtle,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant='heading' weight='semibold' numberOfLines={1}>
          {screenTitle ?? fallbackTitle}
        </Text>
      </View>

      <SearchField />

      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 4,
        }}
      >
        {isAdmin ? <SessionsButton /> : null}
        <UserMenu />
      </View>
    </View>
  );
};

/**
 * "Who is watching right now."
 *
 * Administrators only, because `/Sessions` needs elevation — the same gate the
 * native header applies. It goes accent while somebody is playing something,
 * which is the one thing worth noticing at a glance.
 */
const SessionsButton: React.FC = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const { accent, accentName } = useTheme();
  const { sessions = [] } = useSessions({} as useSessionsProps);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      testID='shell-sessions'
      accessibilityRole='button'
      accessibilityLabel={t("home.sessions.title")}
      onPress={() => router.push("/(auth)/(tabs)/(home)/sessions")}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={
        {
          width: 36,
          height: 36,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius.sm,
          backgroundColor: hovered ? tokens.color.bg["3"] : "transparent",
          ...(Platform.OS === "web"
            ? { cursor: "pointer", ...webFocusRing(focused, accentName) }
            : null),
        } as ViewStyle
      }
    >
      <Icon
        name='devices'
        size={20}
        color={sessions.length > 0 ? accent[500] : tokens.color.text.secondary}
      />
    </Pressable>
  );
};
