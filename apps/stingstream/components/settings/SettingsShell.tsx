import { usePathname } from "expo-router";
import { useAtomValue } from "jotai";
import type { PropsWithChildren } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import {
  buildSettingsCategories,
  categoryForRoute,
  type SettingsCategory,
  settingsPath,
} from "@/components/shell/buildSettingsCategories";
import { settingsTwoPane } from "@/constants/Settings";
import useRouter from "@/hooks/useAppRouter";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import { userAtom } from "@/providers/JellyfinProvider";
import { SettingsNav } from "./SettingsNav";

/**
 * The frame every settings page sits in.
 *
 * Above `SETTINGS_TWO_PANE_MIN_WIDTH` it draws the category column beside the
 * page; below it, it draws nothing at all and the page is the whole screen,
 * reached and left the way it always was — a row on the landing list, and the
 * stack's own back control.
 *
 * **It is a component, not a layout route.** Settings could have grown an
 * `app/.../settings/_layout.tsx`, which would keep the column mounted across a
 * category change; that means a second `Stack` nested inside the `(home)` one,
 * and the shell has scar tissue about adding navigators (see
 * `WebShellLayout`'s docblock — swapping navigator kinds at a breakpoint
 * rendered "Something went wrong"). Re-mounting a pure two-argument list on
 * each move is the cheaper half of that trade.
 *
 * It also adds no `ScrollView` and no `PageContainer`. Every page inside it
 * already brings its own — usually `RefreshScreen`, which is exactly those two
 * plus pull-to-refresh — and nesting a second scroller inside the first is how
 * a page ends up with two scrollbars and a sticky header that is not sticky.
 */
export const SettingsShell: React.FC<
  PropsWithChildren<{
    /**
     * Which category this page belongs to, for lighting its row.
     *
     * Passed explicitly rather than derived, because a page can live *inside* a
     * category without being it — `/settings/servers/join` is Servers. Left out
     * on the compact settings list, which is the navigation rather than a page
     * inside it.
     */
    categoryKey?: string;
  }>
> = ({ categoryKey, children }) => {
  const { color } = useTheme();
  const { t } = useTranslation();
  const { isWebWide, width } = useBreakpoint();
  const user = useAtomValue(userAtom);
  const pathname = usePathname();

  const groups = useMemo(() => buildSettingsCategories(user, t), [user, t]);

  // The prop wins; the route is the fallback, so a page nobody remembered to
  // label still lights the right row.
  const routeCategory = categoryForRoute(groups, pathname ?? "");
  const activeKey = categoryKey ?? routeCategory?.key;

  // A page inside a category rather than the category itself: This server, one connected server,
  // one library, one plugin. Those had no way back but the column or the browser. Dan: *"do an audit
  // on most setting screens either add a back button or something"*. One rule here covers every
  // one of them, including pages added later. Web only: a device's stack header already has one.
  const parent =
    Platform.OS === "web" &&
    routeCategory &&
    settingsPath(pathname ?? "") !== settingsPath(routeCategory.route)
      ? routeCategory
      : null;
  const back = parent ? <BackToCategory category={parent} /> : null;

  if (!settingsTwoPane(width, isWebWide)) {
    // Narrow: the page is the whole screen. With no back link there is nothing to add, so the
    // children are returned as they are rather than wrapped in a fragment that only exists to
    // make the two branches of a ternary match.
    if (!back) return children;
    return (
      <View style={{ flex: 1, backgroundColor: color.bg["0"] }}>
        {back}
        {children}
      </View>
    );
  }

  return (
    <View
      style={{
        flex: 1,
        flexDirection: "row",
        backgroundColor: color.bg["0"],
      }}
    >
      <SettingsNav activeKey={activeKey} />
      {/* `minWidth: 0`, or a wide child — a table of indexers, a log line —
          pushes the column out instead of scrolling inside it, and the page
          grows a horizontal scrollbar. Same reason `WebShellLayout` sets it. */}
      <View testID='settings-pane' style={{ flex: 1, minWidth: 0 }}>
        {back}
        {children}
      </View>
    </View>
  );
};

/** "‹ Servers": up one level, the same move the category's own row makes from here. */
const BackToCategory: React.FC<{ category: SettingsCategory }> = ({
  category,
}) => {
  const { color } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
      <Pressable
        testID='settings-back'
        role='link'
        aria-label={`${t("shell.back")}: ${category.label}`}
        // `navigate`, as `SettingsNav` does for the same move: it pops to the category page already
        // below in the stack instead of pushing a second copy of it.
        onPress={() => router.navigate(category.route as never)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          alignSelf: "flex-start",
          gap: 4,
          paddingVertical: 6,
          paddingRight: 8,
        }}
      >
        <Icon name='chevronLeft' size={18} color={color.text.secondary} />
        <Text variant='body' tone='secondary'>
          {category.label}
        </Text>
      </Pressable>
    </View>
  );
};
