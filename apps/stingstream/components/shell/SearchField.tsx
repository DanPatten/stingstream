import { useGlobalSearchParams, useSegments } from "expo-router";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { elevation, radius, webFocusRing } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useFocusVisible } from "@/hooks/useFocusVisible";
import { useTheme } from "@/hooks/useTheme";
import { useRequestsMode } from "@/lib/stingstream/requests";
import { userAtom } from "@/providers/JellyfinProvider";
import {
  buildSettingsSearchIndex,
  type SettingsSearchEntry,
  searchSettings,
} from "./settingsSearchIndex";

const MAX_WIDTH = 480;
/** Long enough that a fast typist does not push a route update per keystroke. */
const LIVE_UPDATE_DELAY = 250;

/**
 * The top bar's search box.
 *
 * Three behaviours, because a search field in a persistent chrome has three
 * jobs — and the third one is not about media at all.
 *
 * **From anywhere else**, Enter is a navigation: it opens the Search tab with
 * what you typed.
 *
 * **On Search itself** the field *is* that screen's input — the screen re-reads
 * its `q` route param whenever it changes — so every keystroke updates the
 * param after a short debounce and results follow as you type, with no second
 * Enter. Exactly one screen reads a term. Requests was on that list too for a
 * while, so that its Find section needed no input of its own on wide web. That
 * made this one box mean two different things depending on the page, put the
 * control for one of six tabs above the tab bar, and left Find's empty state
 * pointing at chrome. Find owns its own box now
 * (`components/stingstream/requests/FindSection.tsx`), and this one means the
 * same thing on Requests as it does everywhere else.
 *
 * **On a settings route** it stops being a media search entirely and becomes
 * "Search settings…", answering out of `settingsSearchIndex` in a panel below
 * itself. A box offering to find movies while you are configuring a transcoder
 * is the least useful control on the screen, and settings are the thing people
 * genuinely cannot find. The index reaches individual *controls*, not pages, so
 * "transcode" lands on the hardware-acceleration toggle and lights it rather
 * than dropping you at the top of a page that contains it somewhere.
 *
 * That mode deliberately writes **no** `q` param. The debounce below targets
 * the focused route, and a settings page that grew a `?q=` it never reads would
 * sit in the address bar beside the `?focus=` that does mean something.
 */
export const SearchField: React.FC = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const segments = useSegments() as string[];
  // `useGlobalSearchParams`, not `useLocalSearchParams`: the top bar is drawn by the shell, outside
  // the navigator, so it has no route of its own and the local hook reads back nothing. The global
  // one answers with the focused route's params wherever it is called from. (`setParams` below is
  // unaffected — it always targets the focused route.)
  const params = useGlobalSearchParams<{ q?: string }>();
  // The same segment test the sidebar's Settings row matches on: every settings
  // page lives inside the `(home)` stack under a `settings` segment.
  const inSettings = segments.includes("settings");
  const onTermScreen = !inSettings && segments.includes("(search)");

  const [value, setValue] = useState("");
  const onTermScreenRef = useRef(onTermScreen);
  onTermScreenRef.current = onTermScreen;
  const inSettingsRef = useRef(inSettings);
  inSettingsRef.current = inSettings;

  // A term the app put on the route itself rather than into this box — a deep
  // link into Search, or a `/search?q=` the app navigated to. Without this the
  // box would sit empty above results it looks like it never asked for. Guarded
  // on being different so the debounce below — which writes this box into the
  // route — cannot feed itself.
  const routeTerm = typeof params.q === "string" ? params.q : "";
  useEffect(() => {
    if (!routeTerm) return;
    setValue((current) => (routeTerm === current ? current : routeTerm));
  }, [routeTerm]);

  // Crossing into or out of settings changes what the box is *for*, and a movie
  // title left sitting in a field labelled "Search settings…" reads as a result
  // set nobody asked for.
  useEffect(() => {
    setValue("");
  }, [inSettings]);

  useEffect(() => {
    if (!onTermScreen || value.length === 0) return;
    const timeout = setTimeout(() => {
      // `setParams` targets the focused route, which is Search: the top bar
      // lives outside the navigator and has no route of its own.
      router.setParams({ q: value });
    }, LIVE_UPDATE_DELAY);
    return () => clearTimeout(timeout);
    // `router` is a fresh object every render (useAppRouter memoises on the
    // expo-router one, which changes), so depending on it would restart the
    // timer on every render and never fire.
  }, [value, onTermScreen]);

  const user = useAtomValue(userAtom);
  // Only polled while the reader is in Settings. This bar is mounted on every screen, and a
  // capability query behind a search box nobody is using is a request every thirty seconds for
  // nothing.
  const requestsMode = useRequestsMode(inSettings);
  const index = useMemo(
    () => (inSettings ? buildSettingsSearchIndex(user, t, requestsMode) : []),
    [inSettings, user, t, requestsMode],
  );
  const matches = useMemo(
    () => (inSettings ? searchSettings(index, value) : []),
    [inSettings, index, value],
  );

  const openSetting = (entry: SettingsSearchEntry) => {
    setValue("");
    router.navigate(entry.href as never);
  };

  const submit = () => {
    const q = value.trim();
    if (q.length === 0) return;
    if (inSettingsRef.current) {
      // Enter takes the top match, which is what a list ranked best-first is
      // for.
      const first = matches[0];
      if (first) openSetting(first);
      return;
    }
    if (onTermScreenRef.current) {
      router.setParams({ q });
      return;
    }
    // A tab root, so `replace` — the shell is one Stack of the tab groups and
    // pushing a second copy of Search onto it would put a back step between
    // you and where you were.
    router.replace({ pathname: "/(auth)/(tabs)/(search)", params: { q } });
  };

  const placeholder = inSettings
    ? t("home.settings.search.placeholder")
    : t("search.search");

  return (
    <View style={{ flex: 1, maxWidth: MAX_WIDTH }}>
      <Input
        testID={inSettings ? "settings-search" : "shell-search"}
        icon='search'
        value={value}
        onChangeText={setValue}
        onSubmitEditing={submit}
        returnKeyType='search'
        placeholder={placeholder}
        accessibilityLabel={placeholder}
        autoCorrect={false}
      />
      {inSettings && value.trim().length > 0 ? (
        <SettingsResults matches={matches} onSelect={openSetting} />
      ) : null}
    </View>
  );
};

/**
 * The panel under the box.
 *
 * Absolutely positioned so it floats over the page rather than making the top
 * bar taller: the bar is a fixed `TOP_BAR_HEIGHT` and every screen under it is
 * laid out against that.
 */
const SettingsResults: React.FC<{
  matches: SettingsSearchEntry[];
  onSelect: (entry: SettingsSearchEntry) => void;
}> = ({ matches, onSelect }) => {
  const { color } = useTheme();
  const { t } = useTranslation();

  return (
    <View
      testID='settings-search-results'
      style={{
        position: "absolute",
        top: 44,
        left: 0,
        right: 0,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: color.border.subtle,
        backgroundColor: color.bg["2"],
        overflow: "hidden",
        zIndex: 30,
        ...elevation(2),
      }}
    >
      {matches.length === 0 ? (
        <View style={{ padding: 14 }}>
          <Text variant='caption' tone='secondary'>
            {t("home.settings.search.no_results")}
          </Text>
        </View>
      ) : (
        matches.map((entry) => (
          <ResultRow key={entry.id} entry={entry} onSelect={onSelect} />
        ))
      )}
    </View>
  );
};

const ResultRow: React.FC<{
  entry: SettingsSearchEntry;
  onSelect: (entry: SettingsSearchEntry) => void;
}> = ({ entry, onSelect }) => {
  const { color } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showRing = useFocusVisible(focused);

  return (
    <Pressable
      testID={`settings-search-result-${entry.id}`}
      accessibilityRole='link'
      accessibilityLabel={`${entry.label}, ${entry.categoryLabel}`}
      onPress={() => onSelect(entry)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 14,
          paddingVertical: 9,
          backgroundColor: hovered ? color.bg["3"] : "transparent",
          ...(Platform.OS === "web"
            ? { cursor: "pointer", ...webFocusRing(showRing, color) }
            : null),
        } as ViewStyle
      }
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant='body' numberOfLines={1}>
          {entry.label}
        </Text>
        <Text variant='micro' tone='tertiary' numberOfLines={1}>
          {entry.categoryLabel}
        </Text>
      </View>
      {/* The badge earns its place here more than anywhere else: a result list
          is where "Playback quality on this device" and "Limit for viewers
          outside the house" end up two rows apart. */}
    </Pressable>
  );
};
