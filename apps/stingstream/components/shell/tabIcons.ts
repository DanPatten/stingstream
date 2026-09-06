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
 */
export const TAB_KEYS = [
  "(home)",
  "(search)",
  "(favorites)",
  "(watchlists)",
  "(libraries)",
  "(custom-links)",
  "(requests)",
  "(manage)",
  "(downloads)",
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
  "(settings)": "settings",
};

/**
 * `testID`s follow the *wording*, not the route name.
 *
 * The route group is `(downloads)` and the label is "Transfers"; `(libraries)`
 * is labelled "Library". A test that looks for what the screen says is the one
 * that keeps working when a route is renamed, so `tab-transfers` and
 * `tab-library` are the ids, and this table is the only place the two
 * vocabularies meet.
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
  "(settings)": "tab-settings",
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
  "(settings)": "tabs.settings",
};

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
