import { usePathname } from "expo-router";
import { useAtomValue } from "jotai";
import type { PropsWithChildren } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import {
  buildSettingsCategories,
  categoryForRoute,
} from "@/components/shell/buildSettingsCategories";
import { settingsTwoPane } from "@/constants/Settings";
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
  const activeKey =
    categoryKey ?? categoryForRoute(groups, pathname ?? "")?.key;

  if (!settingsTwoPane(width, isWebWide)) return <>{children}</>;

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
        {children}
      </View>
    </View>
  );
};
