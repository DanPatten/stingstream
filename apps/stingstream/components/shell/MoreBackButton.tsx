import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { HeaderButton } from "@/components/common/HeaderButton";
import { HeaderIcon } from "@/components/common/HeaderIcon";
import useRouter from "@/hooks/useAppRouter";

/**
 * The way back out of a group the More list opened.
 *
 * Favorites, Watchlists, Manage, Transfers and Custom links are tab *roots*, so
 * a native stack draws no back button for them — and on a phone their tab
 * button is hidden (F-08), which leaves the screen with no visible way back at
 * all. On compact they are only ever reached from More, so the chevron goes
 * straight there rather than guessing at history: the tab navigator's own
 * `goBack` lands on the first tab, not on the one you came from.
 */
export const MoreBackButton: React.FC = () => {
  const router = useRouter();
  const { t } = useTranslation();

  const goBack = useCallback(() => {
    router.replace("/(auth)/(tabs)/(settings)");
  }, [router]);

  return (
    <HeaderButton
      placement='left'
      testID='header-back-to-more'
      accessibilityRole='button'
      accessibilityLabel={t("tabs.more")}
      onPress={goBack}
      // The same leading inset `HeaderMark` explains: a custom left view costs
      // the header its own, and a chevron flush against the edge of the screen
      // does not look like the native back button it stands in for.
      style={{ marginLeft: Platform.OS === "ios" ? 0 : 12 }}
    >
      <HeaderIcon name='back' />
    </HeaderButton>
  );
};

export default MoreBackButton;
