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
import { type PropsWithChildren, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Platform, View } from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { TAB_LABEL_FONT_SIZE, tabTestID } from "@/components/shell/tabIcons";
import { WebShellLayout } from "@/components/shell/WebShellLayout";
import { WatchTogetherBanner } from "@/components/stingstream/watch/WatchTogetherBanner";
import type { TVNavRailItem } from "@/components/tv/TVNavRail";
import { TVNavRail } from "@/components/tv/TVNavRail";
import { rgba, tokens } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import {
  isAtTabRoot,
  isTabRoute,
  useTVHomeBackHandler,
  useTVTabRootBackHandler,
} from "@/hooks/useTVBackHandler";
import { useTVUserSwitchModal } from "@/hooks/useTVUserSwitchModal";
import { apiAtom, useJellyfin, userAtom } from "@/providers/JellyfinProvider";
import { useSettings } from "@/utils/atoms/settings";
import { eventBus } from "@/utils/eventBus";
import {
  getPreviousServers,
  type SavedServerAccount,
} from "@/utils/secureCredentials";

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

/** Two letters from a display name, for the rail's account button. */
function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function TVTabLayout() {
  const { settings } = useSettings();
  const { t } = useTranslation();
  const segments = useSegments();
  const router = useRouter();
  const user = useAtomValue(userAtom);
  const api = useAtomValue(apiAtom);
  const { loginWithSavedCredential } = useJellyfin();
  const { showUserSwitchModal } = useTVUserSwitchModal();

  const currentTab = segments.find(isTabRoute);
  const atTabRoot = isAtTabRoot(segments);

  const tabs: TVNavRailItem[] = useMemo(
    () =>
      (
        [
          { key: "(home)", label: t("tabs.home"), icon: "home" },
          { key: "(search)", label: t("tabs.search"), icon: "search" },
          {
            key: "(favorites)",
            label: t("tabs.favorites"),
            icon: "favorite" as const,
          },
          !settings?.streamyStatsServerUrl || settings?.hideWatchlistsTab
            ? null
            : {
                key: "(watchlists)",
                label: t("watchlists.title"),
                icon: "watchlist" as const,
              },
          {
            key: "(libraries)",
            label: t("tabs.library"),
            icon: "library" as const,
          },
          // Requests is the one StingStream tab a non-administrator gets, so unlike Manage and
          // Downloads it is here on TV too. The screen itself drops Approvals and Policy on a
          // television: approving on a remote control is worse than doing it on the phone that is
          // already in the room.
          {
            key: "(requests)",
            label: t("tabs.requests"),
            icon: "requests" as const,
          },
          !settings?.showCustomMenuLinks
            ? null
            : {
                key: "(custom-links)",
                label: t("tabs.custom_links"),
                icon: "link" as const,
              },
          {
            key: "(settings)",
            label: t("tabs.settings"),
            icon: "settings" as const,
          },
        ] as (TVNavRailItem | null)[]
      ).filter((tab): tab is TVNavRailItem => tab !== null),
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

  const currentServer = useMemo(() => {
    if (!api?.basePath) return null;
    return getPreviousServers().find((s) => s.address === api.basePath) ?? null;
  }, [api?.basePath]);

  const handleAccountSelect = useCallback(
    async (account: SavedServerAccount) => {
      if (!currentServer) return;

      // A television is a household device, so accounts saved by the code
      // sign-in carry no secret and can simply be switched to. A PIN or
      // password account needs its entry sheet, which lives on the settings
      // screen with the rest of the account machinery; send the viewer there
      // rather than growing a second copy of those modals in the navigator.
      if (account.securityType === "none") {
        try {
          await loginWithSavedCredential(currentServer.address, account.userId);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : t("server.session_expired");
          Alert.alert(t("login.connection_failed"), message);
        }
        return;
      }

      router.replace("/(auth)/(tabs)/(settings)");
    },
    [currentServer, loginWithSavedCredential, router, t],
  );

  const handleAccountPress = useCallback(() => {
    if (!currentServer || !user?.Id) return;
    showUserSwitchModal(currentServer, user.Id, {
      onAccountSelect: handleAccountSelect,
    });
  }, [currentServer, user?.Id, showUserSwitchModal, handleAccountSelect]);

  // The rail's account button is only worth a focus stop when there is another
  // account to switch to; `showUserSwitchModal` refuses below two anyway.
  const canSwitchUser = (currentServer?.accounts.length ?? 0) > 1;

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
      <TVNavRail
        items={tabs}
        activeKey={activeTabKey}
        onSelect={handleTabChange}
        accountInitials={initialsOf(user?.Name)}
        accountLabel={user?.Name ?? undefined}
        onAccountPress={canSwitchUser ? handleAccountPress : undefined}
        style={{ zIndex: 1000 }}
      />
    </View>
  );
}

/**
 * The width below which the bar drops its labels.
 *
 * Five items across 360 dp is 72 dp each, and "Requests" at 11 px still fits
 * inside that with room to spare. Below it, a label would have to shrink or
 * ellipsise — F-08 says it may do neither — so the glyphs stand alone, which is
 * what every phone launcher does at that width anyway.
 */
const ICON_ONLY_BELOW = 360;

/** No chrome — a phone, a tablet, and every browser window under 768 px. */
const PlainFrame: React.FC<PropsWithChildren> = ({ children }) => (
  <View style={{ flex: 1 }}>{children}</View>
);

export default function TabLayout() {
  const { t } = useTranslation();
  const { isCompact, width } = useBreakpoint();
  const { accent } = useTheme();
  // Who sees Manage, Transfers, Watchlists and Custom links is no longer a
  // question this file answers. Those four groups are behind More on every
  // phone and narrow window, and `buildMoreItems` applies the gates that used
  // to live in the `tabBarItemHidden` lines below — the administrator one
  // included (every Manage and Transfers endpoint requires Jellyfin's
  // RequiresElevation policy; see docs/UI-API-GAPS.md).

  // Must be called before any conditional return (rules of hooks)
  useTVHomeBackHandler();

  if (IS_ANDROID_TV) {
    return <TVTabLayout />;
  }

  // A browser window 768 px or wider gets the desktop chrome — sidebar and top
  // bar — instead of a bottom tab bar sized for a thumb.
  //
  // **The navigator underneath is the same one at every width.** It used to be
  // a `Stack` above 768 and a bottom-tab navigator below, and dragging a window
  // across that line handed one router the other's navigation state: react
  // navigation reads fields off it that the other kind has never had, and the
  // app rendered "Something went wrong". So the shell is furniture around the
  // navigator now, not a second navigator — which also means your tab and your
  // place in it survive the resize.
  const wide = Platform.OS === "web" && !isCompact;
  const Frame = wide ? WebShellLayout : PlainFrame;

  /*
    The bar Dan reviewed had seven tabs on a 390 px phone and truncated every
    one of them ("Favor…", "Man…", "Dow…") — pass-01 F-08. Five stay: Home,
    Search, Library, Requests and More. The other five groups keep their routes
    and their screens and lose only their buttons (`tabBarItemHidden`), and the
    More tab lists them; see `components/shell/MoreScreen.tsx`.

    The declaration order below is the navigator's route order, and `TAB_KEYS`
    is a copy of it that the sidebar and the two tab bars read; keep the two in
    step.
  */
  return (
    <Frame>
      <SystemBars hidden={false} style='light' />
      <NativeTabs
        sidebarAdaptable={false}
        // On web wide the bar goes and the sidebar takes its place; the
        // navigator itself carries on.
        tabBarHidden={wide}
        tabBarStyle={{
          backgroundColor: tokens.color.bg["1"],
        }}
        tabBarActiveTintColor={
          Platform.isTV ? "#FFFFFF" : (accent[500] as string)
        }
        tabBarInactiveTintColor={tokens.color.text.tertiary}
        // Material hides the labels of unselected items as soon as there are
        // four or more of them. F-08 wants all five spelled out, so the bar is
        // told explicitly — and told to stop at the width where they no longer
        // fit.
        labeled={width >= ICON_ONLY_BELOW}
        tabLabelStyle={{ fontSize: TAB_LABEL_FONT_SIZE }}
        activeIndicatorColor={rgba(accent[500], 0.16)}
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
            tabBarButtonTestID: tabTestID("(home)"),
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
            tabBarButtonTestID: tabTestID("(search)"),
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
            // Behind More from here on (F-08): five buttons is what a 360 dp
            // bar can label without cutting one short.
            tabBarItemHidden: true,
            tabBarButtonTestID: tabTestID("(favorites)"),
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
            // Behind More, and only listed there when Streamystats is
            // configured and the user has not hidden it — `buildMoreItems`
            // keeps that condition, which is the one this line used to carry.
            tabBarItemHidden: true,
            tabBarButtonTestID: tabTestID("(watchlists)"),
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
            tabBarButtonTestID: tabTestID("(libraries)"),
            tabBarIcon:
              Platform.OS === "android"
                ? (_e) => require("@/assets/icons/rectangle.stack.fill.png")
                : (_e) => ({ sfSymbol: "rectangle.stack.fill" }),
          }}
        />
        <NativeTabs.Screen
          name='(manage)'
          options={{
            title: t("tabs.manage"),
            // Behind More, and only for an administrator — see the note on
            // `isStingStreamAdmin` above, which is now enforced by
            // `buildMoreItems` instead of by this line.
            tabBarItemHidden: true,
            tabBarButtonTestID: tabTestID("(manage)"),
            tabBarIcon:
              Platform.OS === "android"
                ? (_e) => require("@/assets/icons/manage.sliders.png")
                : (_e) => ({ sfSymbol: "slider.horizontal.3" }),
          }}
        />
        <NativeTabs.Screen
          name='(downloads)'
          options={{
            title: t("tabs.transfers"),
            tabBarItemHidden: true,
            tabBarButtonTestID: tabTestID("(downloads)"),
            tabBarIcon:
              Platform.OS === "android"
                ? (_e) => require("@/assets/icons/downloads.arrow.png")
                : (_e) => ({ sfSymbol: "arrow.down.circle.fill" }),
          }}
        />
        <NativeTabs.Screen
          name='(requests)'
          options={{
            title: t("tabs.requests"),
            // Visible to every member, not only administrators: asking the node for something
            // needs nothing but a Jellyfin account, and the elevated half of the screen simply
            // is not offered to anybody else.
            tabBarButtonTestID: tabTestID("(requests)"),
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
            // Behind More, listed there only when the user has switched the
            // tab on — without that row it would be unreachable on a phone.
            tabBarItemHidden: true,
            tabBarButtonTestID: tabTestID("(custom-links)"),
            tabBarIcon:
              Platform.OS === "android"
                ? (_e) => require("@/assets/icons/link.png")
                : (_e) => ({ sfSymbol: "link" }),
          }}
        />
        <NativeTabs.Screen
          // The fifth button. On a television this group is Settings and the
          // rail labels it so; everywhere else it is More, and its screen is
          // the list of everything the bar could not fit.
          name='(settings)'
          options={{
            title: Platform.isTV ? t("tabs.settings") : t("tabs.more"),
            tabBarItemHidden: false,
            tabBarButtonTestID: tabTestID("(settings)"),
            tabBarIcon: Platform.isTV
              ? (_e) => ({ sfSymbol: "gearshape.fill" })
              : Platform.OS === "android"
                ? (_e) => require("@/assets/icons/more.ellipsis.png")
                : (_e) => ({ sfSymbol: "ellipsis" }),
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
    </Frame>
  );
}
