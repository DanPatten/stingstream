import type { Ionicons } from "@expo/vector-icons";
import type { CollectionType } from "@jellyfin/sdk/lib/generated-client/models";
import type { IconName } from "@/components/common/Icon";

/**
 * The vocabulary the two web navigators share.
 *
 * The desktop sidebar and the compact bottom tab bar draw the same tabs with
 * the same glyphs and the same `testID`s; keeping the three tables here means
 * "what icon is Transfers?" has one answer rather than one per navigator. The
 * native tab bar is deliberately not a consumer: it takes SF Symbol
 * descriptors and `require()`d PNGs, neither of which is an `Icon` name.
 */

/**
 * Every tab group under `app/(auth)/(tabs)`.
 *
 * `CLAUDE.test.ts` pins the same list against the directory, so this is a copy
 * that cannot silently rot: a group added there without a line here renders
 * with the fallback glyph and a `tab-(whatever)` test id, which the shell's own
 * screenshot pass would show immediately.
 *
 * **The order is load bearing.** It is the order `app/(auth)/(tabs)/_layout.tsx`
 * declares its `NativeTabs.Screen`s in, and `WebShellLayout` declares its
 * `Stack.Screen`s from this list so that the two navigators agree. When they
 * did not, dragging a window across 768 px sent a Stack's state into
 * `TabRouter.getStateForRouteNamesChange`, which reads a field a Stack has
 * never had and threw. Change one of the three and change all three.
 */
export const TAB_KEYS = [
  "(home)",
  "(search)",
  "(favorites)",
  "(watchlists)",
  "(libraries)",
  "(manage)",
  "(downloads)",
  "(requests)",
  "(custom-links)",
  "(settings)",
] as const;

export type TabKey = (typeof TAB_KEYS)[number];

export const isTabKey = (name: string): name is TabKey =>
  (TAB_KEYS as readonly string[]).includes(name);

const TAB_ICONS: Record<TabKey, IconName> = {
  "(home)": "home",
  "(search)": "search",
  "(favorites)": "favorite",
  "(watchlists)": "watchlist",
  "(libraries)": "library",
  "(custom-links)": "link",
  "(requests)": "requests",
  "(manage)": "manage",
  "(downloads)": "transfers",
  // Not a gear: on a phone this group is the "More" tab, and the settings row
  // is one line inside the list it shows. See `MoreScreen.tsx`.
  "(settings)": "more",
};

/**
 * `testID`s follow the *wording*, not the route name.
 *
 * The route group is `(downloads)` and the label is "Transfers"; `(libraries)`
 * is labelled "Library"; `(settings)` is labelled "More". A test that looks for
 * what the screen says is the one that keeps working when a route is renamed,
 * so `tab-transfers`, `tab-library` and `tab-more` are the ids, and this table
 * is the only place the two vocabularies meet.
 */
const TAB_TEST_IDS: Record<TabKey, string> = {
  "(home)": "tab-home",
  "(search)": "tab-search",
  "(favorites)": "tab-favorites",
  "(watchlists)": "tab-watchlists",
  "(libraries)": "tab-library",
  "(custom-links)": "tab-custom-links",
  "(requests)": "tab-requests",
  "(manage)": "tab-manage",
  "(downloads)": "tab-transfers",
  "(settings)": "tab-more",
};

/**
 * What a tab is *called*, as an `en.json` key.
 *
 * Both navigators and the top bar's fallback title read this, so "the Downloads
 * group is called Transfers" is written down once. `(watchlists)` reaches
 * outside the `tabs.*` namespace because its screen owns that string already.
 */
const TAB_LABEL_KEYS: Record<TabKey, string> = {
  "(home)": "tabs.home",
  "(search)": "tabs.search",
  "(favorites)": "tabs.favorites",
  "(watchlists)": "watchlists.title",
  "(libraries)": "tabs.library",
  "(custom-links)": "tabs.custom_links",
  "(requests)": "tabs.requests",
  "(manage)": "tabs.manage",
  "(downloads)": "tabs.transfers",
  "(settings)": "tabs.more",
};

/**
 * The URL of each section.
 *
 * A route group's name never appears in a URL, so all ten `index` routes claim
 * `/` and only one of them can win — which is why `/requests` used to fall
 * through to `(libraries)/[libraryId]` and spin (pass-02 F-20). Each group now
 * also holds a named file (`(search)/search.tsx` and friends) that renders the
 * same screen at a path of its own, and this is where the navigators look that
 * path up: the sidebar, the compact tab bar and the More list all navigate by
 * URL, so the address bar, the browser's back button and a bookmark agree with
 * what is on screen.
 *
 * Home keeps `/`. It is where a bare launch lands and where `(home)`'s anchor
 * points; `/home` exists as a redirect for anybody who types it.
 */
const TAB_PATHS: Record<TabKey, string> = {
  "(home)": "/",
  "(search)": "/search",
  "(favorites)": "/favorites",
  "(watchlists)": "/watchlists",
  "(libraries)": "/library",
  "(manage)": "/manage",
  "(downloads)": "/transfers",
  "(requests)": "/requests",
  "(custom-links)": "/links",
  "(settings)": "/more",
};

/** Where a tab group lives in the address bar. */
export const tabPath = (routeName: string): string =>
  isTabKey(routeName) ? TAB_PATHS[routeName] : "/";

/**
 * The compact tab bar's label size, in px, for both navigators.
 *
 * Pass-01 F-08 asks for 10–11 px, which is `micro` at compact — small enough
 * that five labels fit a 360 dp bar without one of them being cut short, which
 * was the actual defect. Below `ICON_ONLY_BELOW` the labels go entirely rather
 * than shrink further.
 */
export const TAB_LABEL_FONT_SIZE = 11;

/** The glyph for a tab group, falling back to a neutral one for a new group. */
export const tabIcon = (routeName: string): IconName =>
  isTabKey(routeName) ? TAB_ICONS[routeName] : "more";

/** The translation key for a tab group's name, or `undefined` for a new group. */
export const tabLabelKey = (routeName: string): string | undefined =>
  isTabKey(routeName) ? TAB_LABEL_KEYS[routeName] : undefined;

/** The `testID` for a tab group's sidebar row or tab-bar button. */
export const tabTestID = (routeName: string): string =>
  isTabKey(routeName) ? TAB_TEST_IDS[routeName] : `tab-${routeName}`;

// ---------------------------------------------------------------------------
// Library glyphs
// ---------------------------------------------------------------------------

export type IoniconName = keyof typeof Ionicons.glyphMap;

/**
 * A user view's glyph, by its Jellyfin collection type.
 *
 * These are raw Ionicons rather than `Icon` names because the semantic
 * registry has one glyph for "a library" and the sidebar lists eight of them at
 * once — a column of identical icons is worse than none. The table matches the
 * one in `components/library/LibraryItemCard.tsx` (WP2's file) so a library
 * looks the same in the sidebar as it does on the Library screen; when that one
 * is exported, this should import it instead.
 */
const COLLECTION_TYPE_ICONS: Record<CollectionType, IoniconName> = {
  movies: "film",
  tvshows: "tv",
  music: "musical-notes",
  books: "book",
  homevideos: "videocam",
  boxsets: "albums",
  playlists: "list",
  folders: "folder",
  livetv: "tv",
  musicvideos: "musical-notes",
  photos: "images",
  trailers: "videocam",
  unknown: "help-circle",
};

export const libraryIcon = (
  collectionType: CollectionType | null | undefined,
): IoniconName =>
  (collectionType && COLLECTION_TYPE_ICONS[collectionType]) || "folder";
