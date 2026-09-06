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
  tabLabelKey,
  tabPath,
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
  t: Translate,
  overrides: Partial<SidebarItem> = {},
): SidebarItem => ({
  key: tab,
  label: t(tabLabelKey(tab) ?? "tabs.home"),
  icon: { set: "semantic", name: tabIcon(tab) },
  testID: tabTestID(tab),
  // The section's public URL, not the route-group path. Navigating by
  // `/(auth)/(tabs)/(search)` lands on that group's `index`, which is `/` — so
  // every section looked identical in the address bar and none of them survived
  // a refresh (pass-02 F-20). See `TAB_PATHS` in `tabIcons.ts`.
  route: { pathname: tabPath(tab) },
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
  // These two keep the fully qualified form: they are pages *inside* the
  // library tab rather than sections of their own, and their URLs
  // (`/[libraryId]`, `/music/[libraryId]/suggestions`) already say which.
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
    tabItem("(favorites)", t),
    ...(showWatchlists ? [tabItem("(watchlists)", t)] : []),
    ...(settings?.showCustomMenuLinks ? [tabItem("(custom-links)", t)] : []),
    tabItem("(requests)", t),
    {
      key: "sharing",
      label: t("shell.sharing"),
      icon: { set: "semantic", name: "sharing" },
      testID: "tab-sharing",
      route: { pathname: "/sharing" },
      navigate: "push",
      match: ["sharing"],
    },
    // Manage and Transfers talk to StingStream.Core, every endpoint of which
    // requires Jellyfin's RequiresElevation policy — a non-administrator who
    // opened them would get a permanently blocked screen, so they are not
    // offered at all. Same gate as the tab bar's `tabBarItemHidden`.
    ...(isAdmin ? [tabItem("(manage)", t), tabItem("(downloads)", t)] : []),
  ];

  return [
    { key: "primary", items: [tabItem("(home)", t)] },
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
          route: { pathname: "/settings" },
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

// ---------------------------------------------------------------------------
// The phone's "More" tab
// ---------------------------------------------------------------------------

export interface MoreGroup {
  key: "browse" | "admin" | "app";
  title: string;
  items: SidebarItem[];
}

/**
 * What the five-icon bottom bar could not fit.
 *
 * Pass-01 F-08: the bar carried seven tabs and truncated every label
 * ("Favor…", "Man…", "Dow…"). Five icons is the most a 360 dp bar can label
 * honestly, so everything else moved behind More — the same rows the desktop
 * sidebar lists, in the same order, with the same admin gating, which is why
 * this is built out of `tabItem` next to `buildSidebarItems` rather than as a
 * second opinion about who sees what.
 *
 * Custom links is here for a reason that is easy to miss: it is a tab the user
 * can switch on in Settings, and hiding it from the bar without listing it here
 * would make it unreachable on a phone.
 */
export function buildMoreItems(
  user: UserDto | null | undefined,
  settings: SidebarSettings | null | undefined,
  t: Translate,
): MoreGroup[] {
  const isAdmin = Boolean(user?.Policy?.IsAdministrator);
  const showWatchlists =
    Boolean(settings?.streamyStatsServerUrl) && !settings?.hideWatchlistsTab;

  const browse: SidebarItem[] = [
    tabItem("(favorites)", t),
    ...(showWatchlists ? [tabItem("(watchlists)", t)] : []),
    ...(settings?.showCustomMenuLinks ? [tabItem("(custom-links)", t)] : []),
  ];

  const app: SidebarItem[] = [
    {
      key: "sharing",
      label: t("shell.sharing"),
      icon: { set: "semantic", name: "sharing" },
      testID: "more-sharing",
      route: { pathname: "/sharing" },
      navigate: "push",
      match: ["sharing"],
    },
    {
      key: "settings",
      label: t("tabs.settings"),
      icon: { set: "semantic", name: "settings" },
      testID: "more-settings",
      route: { pathname: "/settings" },
      navigate: "push",
      match: ["settings"],
    },
  ];

  // Sessions is here on a phone because it is not in the header there: with the
  // app mark holding the leading edge, three actions is the ceiling on compact
  // (pass-02, cross-cutting rule 3), and Sessions is the one that reads as
  // "about the server" rather than "about this screen". On web wide it is a
  // button in the top bar instead.
  const admin: SidebarItem[] = [
    tabItem("(manage)", t),
    tabItem("(downloads)", t),
    {
      key: "sessions",
      label: t("home.sessions.title"),
      icon: { set: "semantic", name: "devices" },
      testID: "more-sessions",
      route: { pathname: "/sessions" },
      navigate: "push",
      match: ["sessions"],
    },
  ];

  return [
    { key: "browse", title: t("shell.more_browse"), items: browse },
    // Same gate as the sidebar's: every Manage and Transfers endpoint requires
    // Jellyfin's RequiresElevation policy, so a member who opened them would
    // get a permanently blocked screen.
    ...(isAdmin
      ? [{ key: "admin" as const, title: t("shell.more_admin"), items: admin }]
      : []),
    { key: "app", title: t("shell.more_app"), items: app },
  ];
}

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
