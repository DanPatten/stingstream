import { getUserViewsApi } from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import { useGlobalSearchParams, usePathname, useSegments } from "expo-router";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import useRouter from "@/hooks/useAppRouter";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { useSettings } from "@/utils/atoms/settings";
import { eventBus } from "@/utils/eventBus";
import {
  activeSidebarKey,
  buildSidebarItems,
  flattenSidebar,
  type SidebarItem,
  type SidebarSection,
} from "./buildSidebarItems";
import { isTabKey, tabLabelKey, tabPath } from "./tabIcons";

export interface ShellNavigation {
  sections: SidebarSection[];
  /** The row the current route belongs to, or `undefined` for a details page. */
  activeKey: string | undefined;
  /** What to head the page with when no screen has claimed a title. */
  pageTitle: string;
  goHome: () => void;
  onSelect: (item: SidebarItem) => void;
}

/**
 * Everything the sidebar needs, at either width.
 *
 * The desktop column and the compact drawer are the same list of the same rows
 * behaving the same way — one is permanent and the other slides in — so the
 * rules for what is in it, which row is lit, and what a click does live here
 * rather than twice. It holds no state of its own: every answer comes from the
 * route (`useSegments`, `usePathname`) and from `buildSidebarItems`, so it can
 * be mounted and unmounted freely as the window crosses 768 px.
 */
export const useShellNavigation = (): ShellNavigation => {
  const { t } = useTranslation();
  const router = useRouter();
  const segments = useSegments() as string[];
  const pathname = usePathname();
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const { settings } = useSettings();

  // The route's own `[libraryId]`, so the sidebar can light the library you are
  // actually looking at rather than "some library".
  const { libraryId } = useGlobalSearchParams<{ libraryId?: string }>();

  // Same query key as `components/library/Libraries.tsx`, on purpose: the
  // sidebar and the Library screen list the same thing and should not fetch it
  // twice or disagree about it.
  const { data: views } = useQuery({
    queryKey: ["user-views", user?.Id],
    queryFn: async () => {
      const response = await getUserViewsApi(api!).getUserViews({
        userId: user?.Id,
      });
      return response.data.Items ?? null;
    },
    staleTime: 60,
    enabled: !!api && !!user?.Id,
  });

  const sections = useMemo(
    () => buildSidebarItems(user, settings, views, t),
    [user, settings, views, t],
  );

  const activeKey = activeSidebarKey(sections, segments, libraryId);
  const activeItem = flattenSidebar(sections).find(
    (item) => item.key === activeKey,
  );

  // Not every tab has a sidebar row — Search is reached from the field in the
  // top bar, a library the user hid is still reachable from a card — so the
  // title falls back to the tab group's own name before it falls back to Home.
  // Without this the Search screen was headed "Home".
  const currentTabLabelKey = tabLabelKey(segments.find(isTabKey) ?? "");
  const pageTitle =
    activeItem?.label ??
    (currentTabLabelKey ? t(currentTabLabelKey) : t("tabs.home"));

  const goHome = useCallback(() => {
    eventBus.emit("scrollToTop");
    router.replace("/(auth)/(tabs)/(home)");
  }, [router]);

  const onSelect = useCallback(
    (item: SidebarItem) => {
      // The same two side effects the phone tab bar fires, so a tab behaves
      // identically however you reached it.
      if (item.tab === "(home)") eventBus.emit("scrollToTop");
      if (item.tab === "(search)") eventBus.emit("searchTabPressed");

      const href = item.route.params
        ? { pathname: item.route.pathname, params: item.route.params }
        : item.route.pathname;

      // "Already there" means *exactly* there, not "somewhere in this tab".
      // Clicking Home from a detail page has to go home — that is most of what
      // a persistent sidebar is for — so only the row's own URL is a no-op, and
      // anything deeper navigates back up to it.
      //
      // Compared against the row's **public** address, not its route. Home is
      // the one row whose `route.pathname` is the fully qualified
      // `/(auth)/(tabs)/(home)/` (see `HOME_ROUTE`), and `pathname` for Home is
      // `/` — so the two could never be equal and Home was the one row that
      // always re-navigated, even from Home.
      const publicPath = item.tab ? tabPath(item.tab) : item.route.pathname;
      if (publicPath === pathname) return;

      if (item.navigate === "replace") {
        router.replace(href as never);
        return;
      }
      // `navigate`, not `push`. `useAppRouter`'s `push` is guarded against
      // double taps by a ref that only resets when the *calling screen* regains
      // focus — and the sidebar is not a screen: it lives outside the navigator
      // and never blurs, so the second push from it, and every one after that,
      // was silently dropped. Confirmed by clicking Settings after Sharing.
      // `navigate` is expo-router's own, ungated, and reuses a matching route
      // rather than stacking a second copy of it, which is what a persistent
      // nav should do anyway.
      router.navigate(href as never);
    },
    [router, pathname],
  );

  return { sections, activeKey, pageTitle, goHome, onSelect };
};
