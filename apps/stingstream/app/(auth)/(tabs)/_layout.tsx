import {
  createNativeBottomTabNavigator,
  type NativeBottomTabNavigationEventMap,
  type NativeBottomTabNavigationOptions,
} from "@bottom-tabs/react-navigation";
import { Stack, useSegments, withLayoutContext } from "expo-router";
import type {
  ParamListBase,
  TabNavigationState,
} from "expo-router/react-navigation";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import type { TVNavBarTab } from "@/components/tv/TVNavBar";
import { TVNavBar } from "@/components/tv/TVNavBar";
import { Colors } from "@/constants/Colors";
import useRouter from "@/hooks/useAppRouter";
import {
  isAtTabRoot,
  isTabRoute,
  useTVHomeBackHandler,
  useTVTabRootBackHandler,
} from "@/hooks/useTVBackHandler";
import { WatchTogetherBanner } from "@/components/stingstream/watch/WatchTogetherBanner";
import { userAtom } from "@/providers/JellyfinProvider";
import { useSettings } from "@/utils/atoms/settings";
import { eventBus } from "@/utils/eventBus";

// Music components are not available on tvOS (TrackPlayer not supported)
const MiniPlayerBar = Platform.isTV
  ? () => null
  : require("@/components/music/MiniPlayerBar").MiniPlayerBar;
const MusicPlaybackEngine = Platform.isTV
  ? () => null
  : require("@/components/music/MusicPlaybackEngine").MusicPlaybackEngine;

// Catches render crashes inside the tab navigator before they bubble to the
// root boundary. The fallback replaces the whole navigator (tab bar
// included) and retry remounts it fresh, discarding navigation state — but
// the session, providers, and root layout survive.
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteErrorBoundary";

const { Navigator } = createNativeBottomTabNavigator();

export const NativeTabs = withLayoutContext<
  NativeBottomTabNavigationOptions,
  typeof Navigator,
  TabNavigationState<ParamListBase>,
  NativeBottomTabNavigationEventMap
>(Navigator);

const IS_ANDROID_TV = Platform.isTV && Platform.OS === "android";

function TVTabLayout() {
  const { settings } = useSettings();
  const { t } = useTranslation();
  const segments = useSegments();
  const router = useRouter();

  const currentTab = segments.find(isTabRoute);
  const atTabRoot = isAtTabRoot(segments);

  const tabs: TVNavBarTab[] = useMemo(
    () =>
      [
        { key: "(home)", label: t("tabs.home") },
        { key: "(search)", label: t("tabs.search") },
        { key: "(favorites)", label: t("tabs.favorites") },
        !settings?.streamyStatsServerUrl || settings?.hideWatchlistsTab
          ? null
          : { key: "(watchlists)", label: t("watchlists.title") },
        { key: "(libraries)", label: t("tabs.library") },
        // Requests is the one StingStream tab a non-administrator gets, so unlike Manage and
        // Downloads it is here on TV too. The screen itself drops Approvals and Policy on a
        // television: approving on a remote control is worse than doing it on the phone that is
        // already in the room.
        { key: "(requests)", label: "Requests" },
        !settings?.showCustomMenuLinks
          ? null
          : { key: "(custom-links)", label: t("tabs.custom_links") },
        { key: "(settings)", label: t("tabs.settings") },
      ].filter((tab): tab is TVNavBarTab => tab !== null),
    [
      settings?.streamyStatsServerUrl,
      settings?.hideWatchlistsTab,
      settings?.showCustomMenuLinks,
      t,
    ],
  );

  const activeTabKey = currentTab ?? "(home)";

  const visibleKeys = useMemo(
    () => new Set(tabs.map((tab) => tab.key)),
    [tabs],
  );

  const handleTabChange = useCallback(
    (key: string) => {
      if (key === currentTab) return;

      if (key === "(home)") eventBus.emit("scrollToTop");
      if (key === "(search)") eventBus.emit("searchTabPressed");

      router.replace(`/(auth)/(tabs)/${key}`);
    },
    [currentTab, router],
  );

  const navigateHome = useCallback(() => {
    router.replace("/(auth)/(tabs)/(home)");
  }, [router]);
  useTVTabRootBackHandler(navigateHome, atTabRoot, currentTab);

  // If current tab is no longer visible (setting changed), navigate to home
  useEffect(() => {
    if (!visibleKeys.has(activeTabKey) && activeTabKey !== "(home)") {
      router.replace("/(auth)/(tabs)/(home)");
    }
  }, [visibleKeys, activeTabKey, router]);

  return (
    <View style={{ flex: 1 }}>
      <SystemBars hidden={false} style='light' />
      <Stack
        screenOptions={{ headerShown: false, animation: "none" }}
        initialRouteName='(home)'
      >
        <Stack.Screen name='index' redirect />
      </Stack>
      <TVNavBar
        tabs={tabs}
        activeTabKey={activeTabKey}
        onTabChange={handleTabChange}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1000,
        }}
      />
    </View>
  );
}

export default function TabLayout() {
  const { settings } = useSettings();
  const { t } = useTranslation();
  const user = useAtomValue(userAtom);
  // Manage/Downloads talk to StingStream.Core, which requires Jellyfin's
  // RequiresElevation policy on every endpoint (see docs/UI-API-GAPS.md and
  // packages/api-client) — hide the tabs entirely for non-admins rather than
  // showing a permanently-blocked screen.
  const isStingStreamAdmin = !!user?.Policy?.IsAdministrator;

  // Must be called before any conditional return (rules of hooks)
  useTVHomeBackHandler();

  if (IS_ANDROID_TV) {
    return <TVTabLayout />;
  }

  return (
    <View style={{ flex: 1 }}>
      <SystemBars hidden={false} style='light' />
      <NativeTabs
        sidebarAdaptable={false}
        tabBarStyle={{
          backgroundColor: "#121212",
        }}
        tabBarActiveTintColor={Platform.isTV ? "#FFFFFF" : Colors.primary}
        activeIndicatorColor={"#392c3b"}
        scrollEdgeAppearance='default'
      >
        <NativeTabs.Screen redirect name='index' />
        <NativeTabs.Screen
          listeners={(_e) => ({
            tabPress: (_e) => {
              eventBus.emit("scrollToTop");
            },
          })}
          name='(home)'
          options={{
            title: t("tabs.home"),
            tabBarIcon:
              Platform.OS === "android"
                ? (_e) => require("@/assets/icons/house.fill.png")
                : (_e) => ({ sfSymbol: "house.fill" }),
          }}
        />
        <NativeTabs.Screen
          listeners={(_e) => ({
            tabPress: (_e) => {
              eventBus.emit("searchTabPressed");
            },
          })}
          name='(search)'
          options={{
            role: "search",
            title: t("tabs.search"),
            tabBarIcon:
              Platform.OS === "android"
                ? (_e) => require("@/assets/icons/magnifyingglass.png")
                : (_e) => ({ sfSymbol: "magnifyingglass" }),
          }}
        />
        <NativeTabs.Screen
          name='(favorites)'
          options={{
            title: t("tabs.favorites"),
            tabBarIcon:
              Platform.OS === "android"
                ? (_e) => require("@/assets/icons/heart.fill.png")
                : (_e) => ({ sfSymbol: "heart.fill" }),
          }}
        />
        <NativeTabs.Screen
          name='(watchlists)'
          options={{
            title: t("watchlists.title"),
            tabBarItemHidden:
              !settings?.streamyStatsServerUrl || settings?.hideWatchlistsTab,
            tabBarIcon:
              Platform.OS === "android"
                ? (_e) => require("@/assets/icons/list.star.png")
                : (_e) => ({ sfSymbol: "list.star" }),
          }}
        />
        <NativeTabs.Screen
          name='(libraries)'
          options={{
            title: t("tabs.library"),
            tabBarIcon:
              Platform.OS === "android"
                ? (_e) => require("@/assets/icons/rectangle.stack.fill.png")
                : (_e) => ({ sfSymbol: "rectangle.stack.fill" }),
          }}
        />
        <NativeTabs.Screen
          name='(manage)'
          options={{
            title: "Manage",
            tabBarItemHidden: Platform.isTV || !isStingStreamAdmin,
            tabBarIcon:
              Platform.OS === "android"
                ? (_e) => require("@/assets/icons/manage.sliders.png")
                : (_e) => ({ sfSymbol: "slider.horizontal.3" }),
          }}
        />
        <NativeTabs.Screen
          name='(downloads)'
          options={{
            title: "Downloads",
            tabBarItemHidden: Platform.isTV || !isStingStreamAdmin,
            tabBarIcon:
              Platform.OS === "android"
                ? (_e) => require("@/assets/icons/downloads.arrow.png")
                : (_e) => ({ sfSymbol: "arrow.down.circle.fill" }),
          }}
        />
        <NativeTabs.Screen
          name='(requests)'
          options={{
            title: "Requests",
            // Visible to every member, not only administrators: asking the node for something
            // needs nothing but a Jellyfin account, and the elevated half of the screen simply
            // is not offered to anybody else.
            tabBarIcon:
              Platform.OS === "android"
                ? (_e) => require("@/assets/icons/requests.bubble.png")
                : (_e) => ({ sfSymbol: "plus.bubble.fill" }),
          }}
        />
        <NativeTabs.Screen
          name='(custom-links)'
          options={{
            title: t("tabs.custom_links"),
            tabBarItemHidden: !settings?.showCustomMenuLinks,
            tabBarIcon:
              Platform.OS === "android"
                ? (_e) => require("@/assets/icons/link.png")
                : (_e) => ({ sfSymbol: "link" }),
          }}
        />
        <NativeTabs.Screen
          name='(settings)'
          options={{
            title: t("tabs.settings"),
            tabBarItemHidden: !Platform.isTV,
            tabBarIcon:
              Platform.OS === "android"
                ? (_e) => require("@/assets/icons/gearshape.fill.png")
                : (_e) => ({ sfSymbol: "gearshape.fill" }),
          }}
        />
      </NativeTabs>
      {/*
        Watch-together invites, app-wide. An invite is not a screen anybody would think to go and
        look at -- it arrives while you are doing something else -- so it sits here with the mini
        player. It renders nothing at all unless somebody on another node has actually started
        something; see components/stingstream/watch/WatchTogetherBanner.tsx.
      */}
      <WatchTogetherBanner />
      <MiniPlayerBar />
      <MusicPlaybackEngine />
    </View>
  );
}
