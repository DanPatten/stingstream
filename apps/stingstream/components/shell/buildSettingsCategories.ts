import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import type { IconName } from "@/components/common/iconNames";

/**
 * What Settings is made of, for one account on one node.
 *
 * Pure for the same reason `buildSidebarItems.ts` is: who sees which category
 * is a *rule*, not rendering, and it is a rule somebody will change later.
 * Keeping it out of the component means `buildSettingsCategories.test.ts` can
 * pin all of it without React, a navigator or the Jellyfin SDK — and it also
 * means the two-pane navigation column, the phone's category list and the
 * settings search all read the same list rather than three copies of it.
 *
 * This replaces `buildSettingsSections.ts` (deleted), which returned a flat list
 * of rows grouped as General / Sharing / Server. Three things were wrong with
 * that:
 *
 * 1. **The groups mixed scopes.** "General" held both this browser's theme and
 *    the server's own network addresses, so nothing on the screen said whether
 *    a control changed one viewer's app or everybody's server. The *groups* are
 *    what say it now — Media, Sharing & access, Server, You. A per-page badge
 *    saying the same thing again was removed on Dan's word: *"delete all
 *    setting pages badges everywhere"*.
 * 2. **One row did far too much.** *Server settings* was a single click through
 *    to six unrelated pages, and its subtitle listed all six ("Indexers,
 *    download clients, quality profiles, root folders, naming, notifications"),
 *    which is a table of contents rather than a description.
 * 3. **Sharing described itself conversationally** — "Other people who run
 *    StingStream", "Streams go through your server on the web" — without ever
 *    saying whether it linked servers or routed clients. It is one page called
 *    Servers now.
 *
 * The rule that survives unchanged: **a row that can only fail is worse than no
 * row.** Everything in `administration` ends at a screen whose every call needs
 * Jellyfin's `RequiresElevation` policy, so a member is not offered it. Hiding
 * it is the courtesy; the gate is `RequiresAdmin` on the route itself, because
 * a URL can be pasted.
 */

export interface SettingsCategory {
  /** Stable identity: React keys, `testID`s, and the search index's own rows. */
  key: string;
  label: string;
  /** One honest line about what is inside — never a list of the sub-pages. */
  detail: string;
  /** Its address. One category, one URL; see the note on `/users` below. */
  route: string;
  icon: IconName;
  /** `settings-nav-<key>`, so a screenshot pass can click a category by name. */
  testID: string;
}

export interface SettingsCategoryGroup {
  key: "media" | "sharing" | "server" | "you";
  title: string;
  testID: string;
  categories: SettingsCategory[];
}

type Translate = (key: string) => string;

const category = (
  key: string,
  route: string,
  icon: IconName,
  t: Translate,
): SettingsCategory => ({
  key,
  label: t(`home.settings.nav.${key}`),
  detail: t(`home.settings.nav.${key}_hint`),
  route,
  icon,
  testID: `settings-nav-${key}`,
});

/**
 * Every category, in order, for one account.
 *
 * The profile header, the sign-out row and the scope legend the landing page
 * draws around this are unconditional rather than role-conditional, so they
 * stay in the component. This function owns only the part with a rule in it.
 */
export function buildSettingsCategories(
  user: UserDto | null | undefined,
  t: Translate,
): SettingsCategoryGroup[] {
  const isAdmin = Boolean(user?.Policy?.IsAdministrator);

  const you: SettingsCategory[] = [
    category("profile", "/settings/profile", "profile", t),
    // The route keeps its old name. "Appearance" was too narrow for what the
    // page holds (it also carries the app language and the home layout), but
    // renaming the URL would break every bookmark and every pinned screenshot
    // route for a label change.
    category("appearance", "/settings/appearance", "display", t),
    category("playback", "/settings/playback", "playback", t),
    category("about", "/settings/about", "info", t),
  ];

  // What the server holds and how it gets more of it: the libraries and the
  // folders they write to, where it searches, how good a copy has to be, and
  // what the files are called when they land. The half of the product an
  // administrator came to configure, so it leads. Libraries first, because its
  // switch is what every "downloading is not set up" notice is trying to reach.
  //
  // Elevated throughout, so a member is offered none of it, and the routes
  // still carry `RequiresAdmin` because a URL can be pasted.
  const media: SettingsCategory[] = isAdmin
    ? [
        category("storage", "/settings/storage", "storage", t),
        category("services", "/settings/services", "services", t),
        category("quality", "/settings/quality", "quality", t),
        category("files", "/settings/files", "files", t),
      ]
    : [];

  // Who gets in, and from where: accounts and invitations, the servers this
  // one is linked to, and the address the outside world reaches it on.
  //
  // Servers is the one row a member keeps. Federation is neither a preference
  // nor purely an administrator's business: the page shows this server's links
  // (an administrator's half) *and* lets somebody who runs their own node ask
  // to link it (everybody's half).
  //
  // Remote access was two pages until 2026-09-13, Domains and Network & remote
  // access, both answering how anybody reaches this server. It is one page now,
  // the domain and tunnel first and the ports, proxies and certificate under
  // them. Elevated throughout.
  const sharing: SettingsCategory[] = [
    ...(isAdmin ? [category("users", "/settings/users", "users", t)] : []),
    category("servers", "/settings/servers", "servers", t),
    ...(isAdmin
      ? [category("network", "/settings/network", "network", t)]
      : []),
  ];

  // The machine: how it transcodes, what it announces, what it has plugged in,
  // and its log. Every one elevated, so for a member there is no heading.
  const server: SettingsCategory[] = isAdmin
    ? [
        category("transcoding", "/settings/transcoding", "transcoding", t),
        category(
          "notifications",
          "/settings/notifications",
          "notifications",
          t,
        ),
        category("plugins", "/settings/plugins", "plugins", t),
        category("diagnostics", "/settings/diagnostics", "diagnostics", t),
      ]
    : [];

  const groups = {
    media: {
      key: "media" as const,
      title: t("home.settings.nav.group_media"),
      testID: "settings-group-media",
      categories: media,
    },
    sharing: {
      key: "sharing" as const,
      title: t("home.settings.nav.group_sharing"),
      testID: "settings-group-sharing",
      categories: sharing,
    },
    server: {
      key: "server" as const,
      title: t("home.settings.nav.group_server"),
      testID: "settings-group-server",
      categories: server,
    },
    you: {
      key: "you" as const,
      title: t("home.settings.nav.group_you"),
      testID: "settings-group-you",
      categories: you,
    },
  };

  // Ordered for the reader. An administrator is here to configure the server,
  // so that leads and their own preferences go last: Profile is also one click
  // away from their name in the sidebar. A member has only their own things and
  // Servers, so theirs lead. The first category is also where a wide
  // `/settings` lands.
  const ordered: SettingsCategoryGroup[] = isAdmin
    ? [groups.media, groups.sharing, groups.server, groups.you]
    : [groups.you, groups.sharing];

  // A heading with nothing under it is not a group.
  return ordered.filter((group) => group.categories.length > 0);
}

/** Every category, in render order — the shape most callers and tests want. */
export const flattenCategories = (
  groups: SettingsCategoryGroup[],
): SettingsCategory[] => groups.flatMap((group) => group.categories);

/**
 * A pathname reduced to the thing routes are compared by.
 *
 * Drops the query (the settings search navigates with `?focus=<id>` on the
 * end) and any trailing slash, so `/settings/network/` and
 * `/settings/network` are one page rather than two. Exported because two
 * rules ask this question now: which row lights, and what clicking that row
 * should do. They have to agree.
 */
export const settingsPath = (pathname: string): string =>
  pathname.split("?")[0]?.replace(/\/+$/, "") ?? "";

/**
 * The category a route belongs to, for lighting the navigation column.
 *
 * Longest match wins, so `/settings/servers/join` lights Servers rather than
 * matching nothing, and a category whose route is a prefix of another's cannot
 * steal it. The `?` guard matters because the search results navigate with a
 * `?focus=` query on the end.
 */
export const categoryForRoute = (
  groups: SettingsCategoryGroup[],
  pathname: string,
): SettingsCategory | undefined => {
  const path = settingsPath(pathname);
  return flattenCategories(groups)
    .filter((item) => path === item.route || path.startsWith(`${item.route}/`))
    .sort((a, b) => b.route.length - a.route.length)[0];
};

/** What a click on a category row should do from where the reader is now. */
export type SettingsNavIntent = "none" | "navigate" | "replace";

/**
 * What clicking a category row means from the page you are on.
 *
 * The column lights a row for a whole subtree -- `/settings/servers/this` is
 * Servers -- and that is right. It is also what made the row *unclickable*:
 * the press handler compared the lit key with the clicked key and returned, so
 * from a drill-in the way back up was the one link on the page that did
 * nothing. `WebShellLayout` had already settled this for the application
 * sidebar: "already there" means exactly there, not somewhere in this tab.
 * Lighting is a prefix; clicking is an address.
 *
 * - `none` -- the row's own URL, allowing for a trailing slash and the
 *   search's `?focus=`. The only honest no-op.
 * - `navigate` -- you are inside the category, asking to go back up to it. Not
 *   `replace`: the root is normally already below you in the stack (you pushed
 *   your way down), and react-navigation pops back to it rather than stacking
 *   a second copy, so one Back still leaves settings instead of landing on the
 *   URL you just left. On a pasted deep link the root is not in the stack and
 *   `navigate` pushes, which is what a link click should do.
 * - `replace` -- a different category. Categories are siblings of one screen
 *   and `replace` is what keeps them one screen deep. `navigate` cannot be
 *   used here: a sibling is not in the stack either, so it would push, and six
 *   of those is the six-stacked-screens bug `SettingsNav` records.
 *
 * `insideCategory` is the column's own answer to "is this row lit", which is
 * broader than the URL: `/settings/logs` declares itself About by its
 * `categoryKey`, and About is one push below it, so that click is a walk back
 * up too.
 */
export const settingsNavIntent = (
  route: string,
  pathname: string,
  insideCategory = false,
): SettingsNavIntent => {
  const target = settingsPath(route);
  const path = settingsPath(pathname);
  if (path === target) return "none";
  // The trailing slash is load-bearing: `/settings/server` is a redirect stub
  // living next door to `/settings/servers`, and a bare prefix test eats it.
  if (insideCategory || path.startsWith(`${target}/`)) return "navigate";
  return "replace";
};
