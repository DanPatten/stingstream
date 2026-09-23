import { Stack } from "expo-router";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { CastHeaderButton } from "@/components/cast/castHeader";
import {
  HeaderButton,
  HeaderButtonGroup,
} from "@/components/common/HeaderButton";
import { HeaderIcon } from "@/components/common/HeaderIcon";
import { headerTarget } from "@/components/shell/headerTarget";
import {
  nestedTabPageScreenOptions,
  useStackScreenOptions,
  useTabRootScreenOptions,
} from "@/components/stacks/NestedTabPageStack";
import useRouter from "@/hooks/useAppRouter";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useSessions, type useSessionsProps } from "@/hooks/useSessions";
import { useTheme } from "@/hooks/useTheme";
import { useDownload } from "@/providers/DownloadProvider";
import { userAtom } from "@/providers/JellyfinProvider";

// Keeps cold boot on the Home tab.
//
// Every tab group holds an `index` route, so all of them match the launch URL
// `/` equally well — a bare launch has no deep link, so Expo Router resolves
// `/`. It breaks that tie by first preferring a route that is its own group's
// anchor (`isInitial` in the getStateFromPath config sorter), and only then by
// group order, which is alphabetical because Metro sorts the `require.context`
// keys. When #1928 gave `(libraries)` and `(watchlists)` an `anchor` for their
// deep-entry back button, it also promoted them above the unanchored `(home)`,
// and `(libraries)` won that pair alphabetically — so the app booted into the
// library. Anchoring `(home)` puts it back in the running, ahead of
// `(libraries)`.
//
// So: do NOT add `anchor` to a tab group that sorts before `(home)` —
// `(custom-links)` or `(favorites)` — or the app boots into that tab instead.
// An `anchor` on the `(tabs)` layout itself does not help: it only seeds the
// tab underneath whichever tab the URL resolved to.
//
// The anchor is right on its own merits too: a deep link into a home sub-page
// (`/(auth)/(tabs)/(home)/settings`) now seeds the home list underneath, so
// the native stack renders a back button — the same reasoning as the comments
// in the `(libraries)` and `(watchlists)` layouts.
export const unstable_settings = { anchor: "index" };

/**
 * What a settings sub-page's native header looks like.
 *
 * The same three lines were repeated on twenty-odd `Stack.Screen`s, and the
 * settings restructure was about to make it thirty. Only the title varies, and
 * only below 768 px does any of it render at all — `useStackScreenOptions`
 * hides every stack header on web-wide, where the top bar says where you are.
 */
const settingsScreen = (title: string) => ({
  title,
  headerBlurEffect: "none" as const,
  headerTransparent: Platform.OS === "ios",
  headerShadowVisible: false,
});

export default function IndexLayout() {
  const [user] = useAtom(userAtom);
  const { t } = useTranslation();
  const { isCompact } = useBreakpoint();
  const screenOptions = useStackScreenOptions();
  const tabRootOptions = useTabRootScreenOptions();

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen
        name='index'
        options={{
          headerTitle: t("tabs.home"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
          headerRight: () =>
            Platform.isTV ? null : (
              <HeaderButtonGroup>
                {/*
                  No offline downloads in a browser (pass-03 F-52):
                  `expo-file-system` is a stub there, so the button could not
                  work. Casting does work there now, through the Cast Web
                  Sender, so it stays on every platform.
                */}
                {Platform.OS === "web" ? null : <DownloadsButton />}
                {/*
                  Three actions is the ceiling on compact (pass-02, cross-cutting
                  rule 3), and with the app mark now holding the leading edge
                  there is no room for a fourth. Sessions is the one that goes:
                  it is administrator-only, it is about the server rather than
                  about this screen, and it is a row in More — and, at ≥ 768, a
                  button in the top bar.
                */}
                {user?.Policy?.IsAdministrator && !isCompact && (
                  <SessionsButton />
                )}
                <SettingsButton />
                {/* Last, so it is the corner itself, as on every other header. */}
                <CastHeaderButton />
              </HeaderButtonGroup>
            ),
          ...tabRootOptions,
        }}
      />
      <Stack.Screen
        name='home'
        // A redirect to `/`, so it must not paint a header on the way through.
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name='downloads/index'
        options={{
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          title: t("home.downloads.downloads_title"),
        }}
      />
      <Stack.Screen
        name='sessions/index'
        options={{
          title: t("home.sessions.title"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings'
        options={{
          title: t("home.settings.settings_title"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/playback-controls'
        options={{
          title: t("home.settings.playback_controls.title"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/audio-subtitles'
        options={{
          title: t("home.settings.audio_subtitles.title"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/segment-skip'
        options={{
          title: t("home.settings.other.segment_skip_settings"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/appearance'
        options={{
          // The name this category is called everywhere else -- the settings nav row and the
          // wide-screen page title both use it. `appearance.title` is "Appearance", which is the
          // heading of one section *inside* this page, so using it here gave the same page two
          // names depending on how wide the window was.
          title: t("home.settings.nav.appearance"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/music'
        options={{
          title: t("home.settings.music.title"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/appearance/hide-libraries'
        options={{
          title: t("home.settings.other.hide_libraries"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/plugins'
        options={{
          title: t("home.settings.plugins.plugins_title"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/plugins/marlin-search'
        options={{
          title: "Marlin Search",
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/plugins/jellyseerr'
        options={{
          title: "Jellyseerr",
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/plugins/streamystats'
        options={{
          title: "Streamystats",
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/plugins/kefinTweaks'
        options={{
          title: "KefinTweaks",
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/intro'
        options={{
          title: t("home.settings.intro.title"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/logs'
        options={{
          title: t("home.settings.logs.logs_title"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/network'
        options={{
          title: t("home.settings.network.title"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/server'
        options={{
          title: t("home.settings.nav.services"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='users'
        options={{
          title: t("home.settings.nav.users"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/admin'
        options={{
          title: t("home.settings.nav.storage"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/node'
        options={{
          title: t("home.settings.nav.diagnostics"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/servers'
        options={{
          title: t("home.settings.nav.servers"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      {/* The one sharing screen that is not an administrator's: Servers is about this server,
          this is about the one the reader runs. */}
      <Stack.Screen
        name='settings/my-server'
        options={{
          title: t("identity.my_server_title"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      {/* This server's own page. Its title is the row you pressed to get here, not *Servers*:
          the stack behind it already says that. */}
      <Stack.Screen
        name='settings/servers/this'
        options={{
          title: t("sharing.this_server"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/servers/[group]'
        options={{
          title: t("sharing.servers_title"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      {/* One library's own page, under Libraries. */}
      <Stack.Screen
        name='settings/libraries/[id]'
        options={{
          title: t("home.settings.nav.storage"),
          headerBlurEffect: "none",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
      <Stack.Screen
        name='settings/profile'
        options={settingsScreen(t("home.settings.nav.profile"))}
      />
      <Stack.Screen
        name='settings/playback'
        options={settingsScreen(t("home.settings.nav.playback"))}
      />
      <Stack.Screen
        name='settings/about'
        options={settingsScreen(t("home.settings.nav.about"))}
      />
      <Stack.Screen
        name='settings/users'
        options={settingsScreen(t("home.settings.nav.users"))}
      />
      <Stack.Screen
        name='settings/services'
        options={settingsScreen(t("home.settings.nav.services"))}
      />
      <Stack.Screen
        name='settings/libraries'
        options={settingsScreen(t("home.settings.nav.storage"))}
      />
      <Stack.Screen
        name='settings/quality'
        options={settingsScreen(t("home.settings.nav.quality"))}
      />
      <Stack.Screen
        name='settings/files'
        options={settingsScreen(t("home.settings.nav.files"))}
      />
      <Stack.Screen
        name='settings/notifications'
        options={settingsScreen(t("home.settings.nav.notifications"))}
      />
      <Stack.Screen
        name='settings/transcoding'
        options={settingsScreen(t("home.settings.nav.transcoding"))}
      />
      <Stack.Screen
        name='settings/diagnostics'
        options={settingsScreen(t("home.settings.nav.diagnostics"))}
      />
      <Stack.Screen
        name='settings/domains'
        options={settingsScreen(t("home.settings.nav.network"))}
      />
      {Object.entries(nestedTabPageScreenOptions).map(([name, options]) => (
        <Stack.Screen key={name} name={name} options={options} />
      ))}
      <Stack.Screen
        name='collections/[collectionId]'
        options={{
          title: "",
          headerBlurEffect: "prominent",
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
        }}
      />
    </Stack>
  );
}

/**
 * The shortcut to what you have saved for offline.
 *
 * It used to be a `headerLeft` that `Home.tsx` installed on itself, which is
 * the slot pass-01 F-13 gives to the app mark — the leading edge is the app's
 * identity, and everything you can *do* with the screen belongs on the right.
 * Moving it here also puts it beside the other three header actions instead of
 * behind a `navigation.setOptions` in a screen effect.
 */
const DownloadsButton = () => {
  const { color } = useTheme();
  const router = useRouter();
  const { t } = useTranslation();
  const { downloadedItems } = useDownload();

  return (
    <HeaderButton
      accessibilityLabel={t("home.downloads.downloads_title")}
      onPress={() => router.push("/(auth)/downloads")}
      style={headerTarget}
    >
      <HeaderIcon
        name='downloads'
        tintColor={downloadedItems.length > 0 ? color.accent[500] : "white"}
      />
    </HeaderButton>
  );
};

const SettingsButton = () => {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <HeaderButton
      accessibilityLabel={t("tabs.settings")}
      onPress={() => router.push("/(auth)/settings")}
      style={headerTarget}
    >
      <HeaderIcon name='settings' />
    </HeaderButton>
  );
};

const SessionsButton = () => {
  const { color } = useTheme();
  const router = useRouter();
  const { t } = useTranslation();
  const { sessions = [] } = useSessions({} as useSessionsProps);

  return (
    <HeaderButton
      accessibilityLabel={t("home.sessions.title")}
      onPress={() => router.push("/(auth)/sessions")}
      style={headerTarget}
    >
      <HeaderIcon
        name='sessions'
        tintColor={sessions.length === 0 ? "white" : color.accent[500]}
      />
    </HeaderButton>
  );
};
