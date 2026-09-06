import { describe, expect, test } from "bun:test";
import type {
  BaseItemDto,
  UserDto,
} from "@jellyfin/sdk/lib/generated-client/models";
import {
  activeSidebarKey,
  buildMoreItems,
  buildSidebarItems,
  flattenSidebar,
  type SidebarSettings,
} from "./buildSidebarItems";
import { TAB_KEYS, tabPath } from "./tabIcons";

// Everything here is the *rules* of the sidebar, which is the only part of the
// shell with rules in it: who sees which row, in what order, and which row is
// lit. None of it needs React, a navigator or the Jellyfin SDK — which is the
// reason `buildSidebarItems` is a plain function and not a hook.

/** Keys are echoed back, so an assertion names the key and not a translation. */
const t = (key: string) => key;

const member: UserDto = { Id: "u1", Name: "Sam" };
const admin: UserDto = {
  Id: "u2",
  Name: "Dan",
  Policy: { IsAdministrator: true } as UserDto["Policy"],
};

const settings = (overrides: Partial<SidebarSettings> = {}): SidebarSettings =>
  ({
    hiddenLibraries: [],
    hideWatchlistsTab: false,
    streamyStatsServerUrl: "",
    showCustomMenuLinks: false,
    ...overrides,
  }) as SidebarSettings;

const view = (
  id: string,
  name: string,
  collectionType?: BaseItemDto["CollectionType"],
): BaseItemDto => ({ Id: id, Name: name, CollectionType: collectionType });

const keys = (...args: Parameters<typeof buildSidebarItems>): string[] =>
  flattenSidebar(buildSidebarItems(...args)).map((i) => i.key);

describe("buildSidebarItems", () => {
  test("a plain member gets Home, the personal rows, Sharing and Settings", () => {
    expect(keys(member, settings(), [], t)).toEqual([
      "(home)",
      "(favorites)",
      "(requests)",
      "sharing",
      "settings",
    ]);
  });

  test("an administrator also gets Manage and Transfers, last", () => {
    expect(keys(admin, settings(), [], t)).toEqual([
      "(home)",
      "(favorites)",
      "(requests)",
      "sharing",
      "(manage)",
      "(downloads)",
      "settings",
    ]);
  });

  test("Transfers is the Downloads tab under its new name", () => {
    const transfers = flattenSidebar(
      buildSidebarItems(admin, settings(), [], t),
    ).find((item) => item.key === "(downloads)");

    expect(transfers?.label).toBe("tabs.transfers");
    expect(transfers?.testID).toBe("tab-transfers");
    expect(transfers?.route.pathname).toBe("/transfers");
  });

  test("every section row carries its own URL, not a route-group path", () => {
    // pass-02 F-20: a group's `index` is `/`, so navigating by
    // `/(auth)/(tabs)/(requests)` left every section sharing one address and
    // none of them surviving a refresh.
    const paths = Object.fromEntries(
      flattenSidebar(
        buildSidebarItems(
          admin,
          settings({
            streamyStatsServerUrl: "http://stats",
            showCustomMenuLinks: true,
          }),
          [],
          t,
        ),
      ).map((item) => [item.key, item.route.pathname]),
    );

    expect(paths).toMatchObject({
      "(home)": "/",
      "(favorites)": "/favorites",
      "(watchlists)": "/watchlists",
      "(custom-links)": "/links",
      "(requests)": "/requests",
      "(manage)": "/manage",
      "(downloads)": "/transfers",
      sharing: "/sharing",
      settings: "/settings",
    });
  });

  test("Watchlists needs Streamystats configured and the tab not hidden", () => {
    const configured = settings({ streamyStatsServerUrl: "http://stats" });

    expect(keys(member, configured, [], t)).toContain("(watchlists)");
    expect(keys(member, settings(), [], t)).not.toContain("(watchlists)");
    expect(
      keys(member, { ...configured, hideWatchlistsTab: true }, [], t),
    ).not.toContain("(watchlists)");
  });

  test("Custom links appear only when the server offers them", () => {
    expect(
      keys(member, settings({ showCustomMenuLinks: true }), [], t),
    ).toContain("(custom-links)");
    expect(keys(member, settings(), [], t)).not.toContain("(custom-links)");
  });

  test("no user and no settings still produces a usable sidebar", () => {
    // The first render after sign-in, before either atom has settled.
    expect(keys(null, null, null, t)).toEqual([
      "(home)",
      "(favorites)",
      "(requests)",
      "sharing",
      "settings",
    ]);
  });
});

describe("buildSidebarItems / libraries", () => {
  const views = [
    view("m", "Movies", "movies"),
    view("t", "Shows", "tvshows"),
    view("a", "Audiobooks", "books"),
    view("s", "Songs", "music"),
    view("l", "Live TV", "livetv"),
  ];

  const libraries = (
    overrides: Partial<SidebarSettings> = {},
    items: BaseItemDto[] = views,
  ) =>
    buildSidebarItems(member, settings(overrides), items, t).find(
      (section) => section.key === "libraries",
    );

  test("one row per view, in the server's order, books excluded", () => {
    expect(libraries()?.items.map((item) => item.label)).toEqual([
      "Movies",
      "Shows",
      "Songs",
      "Live TV",
    ]);
  });

  test("the section is titled and sits between Home and the rest", () => {
    const sections = buildSidebarItems(member, settings(), views, t);
    expect(sections.map((section) => section.key)).toEqual([
      "primary",
      "libraries",
      "secondary",
      "footer",
    ]);
    expect(sections[1]?.title).toBe("shell.libraries");
  });

  test("a library the user hid is not a nav item either", () => {
    expect(
      libraries({ hiddenLibraries: ["m", "l"] })?.items.map((i) => i.key),
    ).toEqual(["library:t", "library:s"]);
  });

  test("no section at all when there is nothing to list", () => {
    expect(libraries({}, [])).toBeUndefined();
    expect(libraries({}, [view("a", "Audiobooks", "books")])).toBeUndefined();
    expect(
      buildSidebarItems(member, settings(), undefined, t).find(
        (section) => section.key === "libraries",
      ),
    ).toBeUndefined();
  });

  test("glyphs come from the collection type, not from one library icon", () => {
    expect(libraries()?.items.map((item) => item.icon)).toEqual([
      { set: "ionicons", name: "film" },
      { set: "ionicons", name: "tv" },
      { set: "ionicons", name: "musical-notes" },
      { set: "ionicons", name: "tv" },
    ]);
  });

  test("music and live TV open their own screens, everything else the grid", () => {
    const routes = Object.fromEntries(
      (libraries()?.items ?? []).map((item) => [item.key, item.route]),
    );

    expect(routes["library:m"]).toEqual({
      pathname: "/(auth)/(tabs)/(libraries)/[libraryId]",
      params: { libraryId: "m" },
    });
    expect(routes["library:s"]).toEqual({
      pathname: "/(auth)/(tabs)/(libraries)/music/[libraryId]/suggestions",
      params: { libraryId: "s" },
    });
    expect(routes["library:l"]).toEqual({
      pathname: "/(auth)/(tabs)/(libraries)/livetv/programs",
    });
  });
});

describe("activeSidebarKey", () => {
  const sections = buildSidebarItems(
    admin,
    settings({ streamyStatsServerUrl: "http://stats" }),
    [view("m", "Movies", "movies")],
    t,
  );

  const at = (segments: string[], libraryId?: string) =>
    activeSidebarKey(sections, segments, libraryId);

  test("the tab group the route is in", () => {
    expect(at(["(auth)", "(tabs)", "(home)", "index"])).toBe("(home)");
    expect(at(["(auth)", "(tabs)", "(requests)", "index"])).toBe("(requests)");
    expect(at(["(auth)", "(tabs)", "(downloads)", "index"])).toBe(
      "(downloads)",
    );
  });

  test("the library in the route, not just 'a library'", () => {
    expect(at(["(auth)", "(tabs)", "(libraries)", "[libraryId]"], "m")).toBe(
      "library:m",
    );
  });

  test("a library that is not in the sidebar lights nothing", () => {
    // Hidden, or a book library: the screen is still reachable from a card.
    expect(
      at(["(auth)", "(tabs)", "(libraries)", "[libraryId]"], "hidden"),
    ).toBeUndefined();
  });

  test("Sharing beats Home, though it lives inside the Home stack", () => {
    expect(at(["(auth)", "(tabs)", "(home)", "sharing"])).toBe("sharing");
  });

  test("Settings wins on its own, and loses to the longer match", () => {
    expect(at(["(auth)", "(tabs)", "(home)", "settings"])).toBe("settings");
    expect(
      at(["(auth)", "(tabs)", "(home)", "settings", "network", "page"]),
    ).toBe("settings");
  });

  test("a route in no tab at all lights nothing", () => {
    expect(at(["(auth)", "player", "direct-player"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The phone's More tab (pass-01 F-08)
// ---------------------------------------------------------------------------

const moreKeys = (...args: Parameters<typeof buildMoreItems>): string[] =>
  buildMoreItems(...args).flatMap((group) => group.items.map((i) => i.key));

describe("buildMoreItems", () => {
  test("a member gets Favorites, Sharing and Settings and no admin group", () => {
    expect(moreKeys(member, settings(), t)).toEqual([
      "(favorites)",
      "sharing",
      "settings",
    ]);
    expect(buildMoreItems(member, settings(), t).map((g) => g.key)).toEqual([
      "browse",
      "app",
    ]);
  });

  test("an administrator gets Manage and Transfers, in their own group", () => {
    const groups = buildMoreItems(admin, settings(), t);

    expect(groups.map((group) => group.key)).toEqual([
      "browse",
      "admin",
      "app",
    ]);
    expect(
      groups.find((group) => group.key === "admin")?.items.map((i) => i.key),
    ).toEqual(["(manage)", "(downloads)", "sessions"]);
  });

  test("everything the five-icon bar hides is reachable from here", () => {
    // The point of the list: a group with no tab button and no row is a screen
    // a phone cannot open at all.
    const all = moreKeys(
      admin,
      settings({
        streamyStatsServerUrl: "http://stats",
        showCustomMenuLinks: true,
      }),
      t,
    );

    for (const hidden of [
      "(favorites)",
      "(watchlists)",
      "(custom-links)",
      "(manage)",
      "(downloads)",
    ]) {
      expect(all).toContain(hidden);
    }
  });

  test("it applies the same gates the sidebar does", () => {
    const configured = settings({ streamyStatsServerUrl: "http://stats" });

    expect(moreKeys(member, configured, t)).toContain("(watchlists)");
    expect(
      moreKeys(member, { ...configured, hideWatchlistsTab: true }, t),
    ).not.toContain("(watchlists)");
    expect(moreKeys(member, settings(), t)).not.toContain("(custom-links)");
    expect(moreKeys(member, settings(), t)).not.toContain("(manage)");
  });

  test("rows carry a route and a testID of their own", () => {
    const rows = buildMoreItems(admin, settings(), t).flatMap((g) => g.items);

    for (const row of rows) {
      expect(row.route.pathname.startsWith("/")).toBe(true);
      expect(row.route.pathname).not.toContain("(");
      expect(row.testID).toBeTruthy();
      expect(row.icon.set).toBe("semantic");
    }
  });

  test("no user and no settings still produces a usable list", () => {
    expect(moreKeys(null, null, t)).toEqual([
      "(favorites)",
      "sharing",
      "settings",
    ]);
  });
});

describe("tab paths", () => {
  test("every tab group has an address of its own", () => {
    // Two sections sharing a path means one of them cannot be linked to, and a
    // section with no path at all falls through to `(libraries)/[libraryId]`,
    // which is the spinner pass-02 F-20 caught.
    const paths = TAB_KEYS.map(tabPath);
    expect(new Set(paths).size).toBe(TAB_KEYS.length);
    expect(tabPath("(home)")).toBe("/");
    for (const path of paths) expect(path.startsWith("/")).toBe(true);
  });

  test("an unknown route name falls back to Home rather than a bad path", () => {
    expect(tabPath("(something-new)")).toBe("/");
  });
});
