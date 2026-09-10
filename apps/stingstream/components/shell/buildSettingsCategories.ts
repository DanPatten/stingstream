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
 *    what say it now — You, Servers, Server administration. A per-page badge
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
  key: "you" | "servers" | "downloading" | "administration";
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

  // Deliberately not folded into `you` or gated into `administration`.
  // Federation is neither a preference nor purely an administrator's business:
  // Servers shows this server and the servers it is linked to (an
  // administrator's half) *and* lets somebody who runs their own node ask to
  // link it (everybody's half, which used to be the separate row "The server I
  // run"), so a member sees it.
  //
  // Domains is the other half of the same subject and is elevated throughout —
  // every call behind it needs `RequiresElevation` — so it follows the rule in
  // this file's header rather than the group it sits in, and a member is not
  // offered it. It was a collapsed "Advanced" disclosure at the bottom of
  // Servers until it grew tunnel setup; the address field inside it is the one
  // control that decides whether anybody can reach this server from a browser
  // away from home, which is not a thing to hide behind a fold.
  const servers: SettingsCategory[] = [
    category("servers", "/settings/servers", "servers", t),
    ...(isAdmin
      ? [category("domains", "/settings/domains", "domains", t)]
      : []),
  ];

  // Everything about getting hold of something the server does not have yet:
  // what it is fetching, where it looks, how good a copy has to be, and what
  // the files are called when they land.
  //
  // Its own group rather than four more rows under `administration`, which is
  // where all four used to sit. That group is the machine — accounts, the
  // network, transcoding, the log — and these four are a *subject*: they are
  // read together, changed together, and they are the half of the product a
  // person actually came to configure. Buried among eleven server-maintenance
  // rows, the one that says whether downloading is even turned on read as
  // maintenance too, which is how somebody following "Requests are not set up"
  // arrived at a page that only told them the same thing again.
  //
  // Elevated throughout, so a member is offered none of it — same rule as
  // `administration`, and the routes still carry `RequiresAdmin` because a URL
  // can be pasted.
  const downloading: SettingsCategory[] = isAdmin
    ? [
        // First, and deliberately: it is the only one of the four that can be
        // *off*, and the answer to "why is none of this doing anything".
        category("arr_library", "/settings/library", "library", t),
        category("services", "/settings/services", "services", t),
        category("quality", "/settings/quality", "quality", t),
        category("files", "/settings/files", "files", t),
      ]
    : [];

  // The whole group, not category by category: every one of these is elevated,
  // so for a member there is nothing left in it to put a heading above.
  const administration: SettingsCategory[] = isAdmin
    ? [
        // First, because who can get in is the question people arrive with.
        // It used to be a section of its own in the sidebar, and before that a
        // tab behind a screen about transcode throttling.
        category("users", "/settings/users", "users", t),
        category("storage", "/settings/storage", "storage", t),
        category("transcoding", "/settings/transcoding", "transcoding", t),
        category("network", "/settings/network", "network", t),
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

  return [
    {
      key: "you" as const,
      title: t("home.settings.nav.group_you"),
      testID: "settings-group-you",
      categories: you,
    },
    {
      key: "servers" as const,
      title: t("home.settings.nav.group_servers"),
      testID: "settings-group-servers",
      categories: servers,
    },
    {
      key: "downloading" as const,
      title: t("home.settings.nav.group_downloading"),
      testID: "settings-group-downloading",
      categories: downloading,
    },
    {
      key: "administration" as const,
      title: t("home.settings.nav.group_administration"),
      testID: "settings-group-administration",
      categories: administration,
    },
    // A heading with nothing under it is not a group.
  ].filter((group) => group.categories.length > 0);
}

/** Every category, in render order — the shape most callers and tests want. */
export const flattenCategories = (
  groups: SettingsCategoryGroup[],
): SettingsCategory[] => groups.flatMap((group) => group.categories);

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
  const path = pathname.split("?")[0]?.replace(/\/+$/, "") ?? "";
  return flattenCategories(groups)
    .filter((item) => path === item.route || path.startsWith(`${item.route}/`))
    .sort((a, b) => b.route.length - a.route.length)[0];
};
