import { usePathname } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, tokens, webFocusRing } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useTheme } from "@/hooks/useTheme";
import { SearchField } from "./SearchField";
import { useFocusVisible } from "./useFocusVisible";
import { useScreenTitle } from "./useScreenTitle";
import { WatchTogetherButton } from "./WatchTogether";

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
 * The Home tab's own header buttons live here now — Watch together on the
 * right; the account and everything under it belong to the sidebar's own
 * account row. Chromecast is not among them: it has no web implementation at
 * all (`docs/M2-web-spike.md` §7).
 *
 * **It also carries the only back control on a desktop.** Every stack header is
 * hidden at this width (see `useStackScreenOptions`) because two titles four
 * pixels apart is what "clunky" looks like — pass-03 F-55 caught Settings
 * saying its own name twice — so the chevron that a stack header would have
 * drawn is here instead, and only when there is somewhere to go back to.
 */
export const TopBar: React.FC<Props> = ({ fallbackTitle }) => {
  const screenTitle = useScreenTitle();
  // Re-read on every navigation: `canGoBack` is a function, not a subscription,
  // so the pathname is what tells React this bar has to look again.
  const pathname = usePathname();
  const router = useRouter();
  const canGoBack = pathname !== "/" && router.canGoBack();

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
      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
        }}
      >
        {canGoBack ? <BackButton onPress={() => router.back()} /> : null}
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
        {/*
          No avatar here. The account already has a permanent row at the foot
          of the sidebar, with the same name and the same menu, and Dan's
          screenshot of the 1.9 k-pixel shell showed the two of them arguing
          about which one you were meant to click. One account control, at the
          bottom left, where the sidebar's own furniture lives.
        */}
        <WatchTogetherButton />
      </View>
    </View>
  );
};

/**
 * The way back, at a width where no screen draws its own header.
 *
 * `router.back()` rather than a computed parent path: what a reader means by
 * "back" is the page they came from, and the stack already knows. It appears
 * only when there is something to pop — a section root is not a page you can
 * leave, it is one you switch away from with the sidebar.
 */
const BackButton: React.FC<{ onPress: () => void }> = ({ onPress }) => {
  const { t } = useTranslation();
  const { accentName } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showRing = useFocusVisible(focused);

  return (
    <Pressable
      testID='shell-back'
      accessibilityRole='button'
      accessibilityLabel={t("shell.back")}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={
        {
          width: 36,
          height: 36,
          marginLeft: -8,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius.sm,
          backgroundColor: hovered ? tokens.color.bg["3"] : "transparent",
          ...(Platform.OS === "web"
            ? { cursor: "pointer", ...webFocusRing(showRing, accentName) }
            : null),
        } as ViewStyle
      }
    >
      <Icon name='chevronLeft' size={20} color={tokens.color.text.secondary} />
    </Pressable>
  );
};
