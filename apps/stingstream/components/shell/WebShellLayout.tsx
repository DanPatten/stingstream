import { getUserViewsApi } from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import { Stack, useGlobalSearchParams, useSegments } from "expo-router";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { WatchTogetherBanner } from "@/components/stingstream/watch/WatchTogetherBanner";
import { tokens } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { useSettings } from "@/utils/atoms/settings";
import { eventBus } from "@/utils/eventBus";
import {
  activeSidebarKey,
  buildSidebarItems,
  flattenSidebar,
  type SidebarItem,
} from "./buildSidebarItems";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { isTabKey, tabLabelKey } from "./tabIcons";

// Music is stubbed on web (docs/M2-web-spike.md §7) but still mounts, exactly
// as it does in the phone branch of `(tabs)/_layout.tsx` — the shell must not
// be the reason a provider stops running.
const MiniPlayerBar = Platform.isTV
  ? () => null
  : require("@/components/music/MiniPlayerBar").MiniPlayerBar;
const MusicPlaybackEngine = Platform.isTV
  ? () => null
  : require("@/components/music/MusicPlaybackEngine").MusicPlaybackEngine;

/**
 * The desktop shell: a sidebar and a top bar around the tab groups.
 *
 * Structurally this is `TVTabLayout` with a different chrome, and deliberately
 * so — that layout already proves the shape works. The ten tab groups become a
 * `Stack` with animations off and `(home)` as the initial route, switching tab
 * is `router.replace` into the group, and which one is current comes from
 * `useSegments()`. No new route, no new group, so `CLAUDE.test.ts` stays green
 * and every screen keeps the URL it already had.
 *
 * **Crossing 768 px remounts the navigator.** The compact branch is a bottom-tab
 * navigator and this one is a `Stack`; they cannot be the same element, so a
 * drag-resize across the breakpoint throws away the navigation state and lands
 * on the tab you were in, at its root. That is accepted (the plan says so): the
 * alternative is one navigator with two skins, which would mean the bottom tab
 * bar's route state on a desktop and a `Stack`'s on a phone — worse in both
 * places for a case that only happens while somebody is dragging a window edge.
 */
export const WebShellLayout: React.FC = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const segments = useSegments() as string[];
  const { isExpanded } = useBreakpoint();
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
      // a persistent sidebar is for — so only the row's own leaf route is a
      // no-op, and anything deeper navigates back up to it.
      const leaf =
        item.tab ?? item.route.pathname.split("/").filter(Boolean).pop();
      if (item.key === activeKey && segments[segments.length - 1] === leaf) {
        return;
      }

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
    [router, segments, activeKey],
  );

  return (
    <View
      style={{
        flex: 1,
        flexDirection: "row",
        backgroundColor: tokens.color.bg["0"],
      }}
    >
      <SystemBars hidden={false} style='light' />
      <Sidebar
        sections={sections}
        activeKey={activeKey}
        collapsed={!isExpanded}
        onSelect={onSelect}
        onPressBrand={goHome}
      />
      {/* `minWidth: 0` or a wide child (a poster row, a table) pushes the
          column out instead of scrolling inside it, and the page grows a
          horizontal scrollbar. */}
      <View style={{ flex: 1, minWidth: 0 }}>
        <TopBar fallbackTitle={pageTitle} />
        <View style={{ flex: 1, backgroundColor: tokens.color.bg["0"] }}>
          <Stack
            screenOptions={{ headerShown: false, animation: "none" }}
            initialRouteName='(home)'
          >
            <Stack.Screen name='index' redirect />
          </Stack>
        </View>
        {/*
          Kept mounted exactly as the phone branch keeps them: a watch-together
          invite arrives while you are doing something else, and the music
          engine is the thing that plays.
        */}
        <WatchTogetherBanner />
        <MiniPlayerBar />
        <MusicPlaybackEngine />
      </View>
    </View>
  );
};

export default WebShellLayout;
