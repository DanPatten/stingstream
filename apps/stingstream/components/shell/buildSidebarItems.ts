import type {
  BaseItemDto,
  UserDto,
} from "@jellyfin/sdk/lib/generated-client/models";
import type { IconName } from "@/components/common/Icon";
import type { Settings } from "@/utils/atoms/settings";
import {
  type IoniconName,
  isTabKey,
  libraryIcon,
  type TabKey,
  tabIcon,
  tabTestID,
} from "./tabIcons";

/**
 * What the desktop sidebar lists, worked out from the four things it depends
 * on and nothing else.
 *
 * Pure on purpose. Which rows a member sees is the one piece of shell logic
 * with real rules in it — an administrator gets two rows nobody else does, a
 * library the user hid must not come back as a nav item, Watchlists depends on
 * a plugin being configured — and every one of those is a rule somebody will
 * change later. Keeping it out of the component means `buildSidebarItems.test.ts`
 * can pin all of them without rendering React, a navigator, or the Jellyfin SDK.
 */

export interface SidebarRoute {
  pathname: string;
  params?: Record<string, string>;
}

/**
 * Nav rows use the semantic registry; library rows use raw Ionicons.
 *
 * `components/common/Icon.tsx` has exactly one glyph meaning "a library", and
 * the sidebar lists every one of the user's views at once — eight identical
 * icons in a column say less than none. See `tabIcons.ts`.
 */
export type SidebarIcon =
  | { set: "semantic"; name: IconName }
  | { set: "ionicons"; name: IoniconName };

export interface SidebarItem {
  /** Stable identity, for React keys and for `activeSidebarKey`. */
  key: string;
  label: string;
  icon: SidebarIcon;
  testID: string;
  route: SidebarRoute;
  /**
   * `replace` for a tab root — the shell is a single `Stack` of the ten tab
   * groups, so switching tabs replaces rather than stacking them — and `push`
   * for a row that opens a page inside one.
   */
  navigate: "replace" | "push";
  /** The tab group this row lights up for, when it is one of the ten. */
  tab?: TabKey;
  /**
   * A more specific match than the tab: every one of these segments must be in
   * the current route for the row to be the active one. Sharing lives inside
   * the `(home)` stack, so without this it would light Home instead of itself.
   */
  match?: string[];
  /** A library row's id, matched against the `[libraryId]` route param. */
  libraryId?: string;
}

export interface SidebarSection {
  key: "primary" | "libraries" | "secondary" | "footer";
  /** Rendered as a small caps label above the rows; absent means no heading. */
  title?: string;
  items: SidebarItem[];
}

/** Only the settings the sidebar actually reads, so a test can pass four keys. */
export type SidebarSettings = Pick<
  Settings,
  | "hiddenLibraries"
  | "hideWatchlistsTab"
  | "streamyStatsServerUrl"
  | "showCustomMenuLinks"
>;

type Translate = (key: string) => string;

const TABS_ROOT = "/(auth)/(tabs)";

const tabItem = (
  tab: TabKey,
  label: string,
  overrides: Partial<SidebarItem> = {},
): SidebarItem => ({
  key: tab,
  label,
  icon: { set: "semantic", name: tabIcon(tab) },
  testID: tabTestID(tab),
  route: { pathname: `${TABS_ROOT}/${tab}` },
  navigate: "replace",
  tab,
  ...overrides,
});

/**
 * Where a user view opens.
 *
 * Music and Live TV have their own screens rather than the generic library
 * grid — the same three-way split `TVLibraries.tsx` and `getItemNavigation`
 * already make, kept identical here so a library opens the same page from the
 * sidebar as it does from a card.
 */
const libraryRoute = (library: BaseItemDto): SidebarRoute => {
  if (library.CollectionType === "livetv") {
    return { pathname: `${TABS_ROOT}/(libraries)/livetv/programs` };
  }
  if (library.CollectionType === "music") {
    return {
      pathname: `${TABS_ROOT}/(libraries)/music/[libraryId]/suggestions`,
      params: { libraryId: library.Id ?? "" },
    };
  }
  return {
    pathname: `${TABS_ROOT}/(libraries)/[libraryId]`,
    params: { libraryId: library.Id ?? "" },
  };
};

/**
 * The sidebar, in order, for one user on one node.
 *
 * `views` is `getUserViewsApi().getUserViews()`; pass `undefined` while it is
 * still in flight and the Libraries section is simply absent, which is what the
 * sidebar should show rather than an empty heading.
 */
export function buildSidebarItems(
  user: UserDto | null | undefined,
  settings: SidebarSettings | null | undefined,
  views: BaseItemDto[] | null | undefined,
  t: Translate,
): SidebarSection[] {
  const isAdmin = Boolean(user?.Policy?.IsAdministrator);
  const hidden = settings?.hiddenLibraries ?? [];

  const libraries = (views ?? [])
    .filter((library) => Boolean(library.Id))
    .filter((library) => !hidden.includes(library.Id as string))
    // The Library screen drops book libraries too: there is no reader in the
    // app, so the grid opens on something nothing can play.
    .filter((library) => library.CollectionType !== "books")
    .map<SidebarItem>((library) => ({
      key: `library:${library.Id}`,
      label: library.Name ?? t("tabs.library"),
      icon: { set: "ionicons", name: libraryIcon(library.CollectionType) },
      testID: `sidebar-library-${library.Id}`,
      route: libraryRoute(library),
      navigate: "push",
      libraryId: library.Id as string,
    }));

  // Same condition the phone tab bar and the TV rail already use: the tab is a
  // Streamystats feature, and the user can hide it even when it is configured.
  const showWatchlists =
    Boolean(settings?.streamyStatsServerUrl) && !settings?.hideWatchlistsTab;

  const secondary: SidebarItem[] = [
    tabItem("(favorites)", t("tabs.favorites")),
    ...(showWatchlists ? [tabItem("(watchlists)", t("watchlists.title"))] : []),
    ...(settings?.showCustomMenuLinks
      ? [tabItem("(custom-links)", t("tabs.custom_links"))]
      : []),
    tabItem("(requests)", t("tabs.requests")),
    {
      key: "sharing",
      label: t("shell.sharing"),
      icon: { set: "semantic", name: "sharing" },
      testID: "tab-sharing",
      route: { pathname: `${TABS_ROOT}/(home)/settings/groups/page` },
      navigate: "push",
      match: ["settings", "groups"],
    },
    // Manage and Transfers talk to StingStream.Core, every endpoint of which
    // requires Jellyfin's RequiresElevation policy — a non-administrator who
    // opened them would get a permanently blocked screen, so they are not
    // offered at all. Same gate as the tab bar's `tabBarItemHidden`.
    ...(isAdmin
      ? [
          tabItem("(manage)", t("tabs.manage")),
          tabItem("(downloads)", t("tabs.transfers")),
        ]
      : []),
  ];

  return [
    { key: "primary", items: [tabItem("(home)", t("tabs.home"))] },
    ...(libraries.length > 0
      ? [
          {
            key: "libraries" as const,
            title: t("shell.libraries"),
            items: libraries,
          },
        ]
      : []),
    { key: "secondary", items: secondary },
    {
      key: "footer",
      items: [
        {
          key: "settings",
          label: t("tabs.settings"),
          icon: { set: "semantic", name: "settings" },
          testID: "tab-settings",
          route: { pathname: `${TABS_ROOT}/(home)/settings` },
          navigate: "push",
          match: ["settings"],
        },
      ],
    },
  ];
}

/** Every row, in render order — the shape most callers and tests want. */
export const flattenSidebar = (sections: SidebarSection[]): SidebarItem[] =>
  sections.flatMap((section) => section.items);

/**
 * Which row is the current one.
 *
 * Three rules, most specific first: an explicit segment match (Sharing sits
 * inside the `(home)` stack and would otherwise light Home), then the library
 * whose id is in the route, then the tab group the route is in. Ties among
 * segment matches go to the longer match, so `settings/groups` beats
 * `settings`.
 */
export function activeSidebarKey(
  sections: SidebarSection[],
  segments: string[],
  libraryId?: string,
): string | undefined {
  const items = flattenSidebar(sections);

  const matched = items
    .filter(
      (item) =>
        item.match?.length &&
        item.match.every((segment) => segments.includes(segment)),
    )
    .sort((a, b) => (b.match?.length ?? 0) - (a.match?.length ?? 0));
  if (matched[0]) return matched[0].key;

  if (libraryId) {
    const library = items.find((item) => item.libraryId === libraryId);
    if (library) return library.key;
  }

  const currentTab = segments.find(isTabKey);
  if (!currentTab) return undefined;
  return items.find((item) => item.tab === currentTab)?.key;
}
