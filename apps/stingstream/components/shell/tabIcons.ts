import type { Ionicons } from "@expo/vector-icons";
import type { CollectionType } from "@jellyfin/sdk/lib/generated-client/models";
import type { IconName } from "@/components/common/Icon";
import { typeStyle } from "@/constants/theme";

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
  "(downloads)": "transfers",
  // Not a gear: on a phone this group is the "More" tab, and the settings row
  // is one line inside the list it shows. See `MoreScreen.tsx`. In a browser
  // the group has no button at all — the bar's last slot is the hamburger.
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
  "(downloads)": "/transfers",
  "(requests)": "/requests",
  "(custom-links)": "/links",
  "(settings)": "/more",
};

/** Where a tab group lives in the address bar. */
export const tabPath = (routeName: string): string =>
  isTabKey(routeName) ? TAB_PATHS[routeName] : "/";

/**
 * Home's route, fully qualified, because `/` is not enough to navigate with.
 *
 * Every tab group holds an `index`, so every group defines `/` — and expo
 * router resolves a bare `/` *within the group you are already in*. Pressing
 * Home from the library therefore landed on `(libraries)/index` with the
 * address bar reading `/` and the screen still showing the library: the Home
 * button did nothing at all. The sidebar has navigated by this path since Dan
 * caught it there ("Oh clicking home is what that is doing"); the compact tab
 * bar had the same bug for the same reason and now uses the same constant.
 *
 * The address bar still reads `/` afterwards, which is Home's real address.
 */
export const HOME_ROUTE = "/(auth)/(tabs)/(home)/";

/**
 * Where a tab *button* should send you: the section's public URL, except Home.
 *
 * Distinct from `tabPath`, which is what a section's address *is* — that is
 * what an active-row check compares against, and what the address bar shows.
 */
export const tabNavigateTarget = (routeName: string): string =>
  routeName === "(home)" ? HOME_ROUTE : tabPath(routeName);

/**
 * The groups that lost their tab button to the five-icon bar.
 *
 * They are reached from the bar's last button and nowhere else at that width, so
 * that button is what should be lit while you are inside one (pass-03 F-58) —
 * More on a phone, the hamburger in a browser. `(custom-links)` is here for the
 * same reason the others are, even though the user has to switch it on before it
 * exists.
 */
const BEHIND_MORE: readonly TabKey[] = [
  "(favorites)",
  "(watchlists)",
  "(downloads)",
  "(custom-links)",
];

export const isBehindMore = (routeName: string | undefined): boolean =>
  routeName !== undefined &&
  (BEHIND_MORE as readonly string[]).includes(routeName);

/**
 * The compact tab bar's label size, in px.
 *
 * The native bar only, since 2026-09-12: the web bar is glyphs alone at every
 * compact width. Dan, on the browser at phone width: "use icons at the bottom
 * instead of names". A platform tab bar is the one place the words stay, because
 * a labelled item is the convention on both phones.
 *
 * Read from the type scale rather than written down. `micro` at compact is
 * 12 px, which is the accessibility floor the screenshot sweep enforces — text
 * below it is a finding. It was 11 for one pass, chosen only because F-08 asked
 * for "10–11 px"; five labels still fit a 360 dp bar at 12, which was the defect
 * F-08 was actually about. Below `ICON_ONLY_BELOW` the labels go entirely rather
 * than shrink further, because shrinking under the floor is not an option.
 */
export const TAB_LABEL_FONT_SIZE = typeStyle("micro", "compact").fontSize;

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
