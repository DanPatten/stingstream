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
  // Browse and Requests is the whole of a member's navigation. Everything elevated is either a
  // gated band (Transfers, Sessions) or a settings category (Users), so there is no row here that
  // can only fail -- the rule the sidebar has applied since Manage went.
  test("a plain member gets Home, the personal rows and Settings", () => {
    expect(keys(member, settings(), [], t)).toEqual([
      "(home)",
      "(favorites)",
      "(requests)",
      "settings",
    ]);
  });

  test("an administrator also gets Transfers and Sessions, last", () => {
    expect(keys(admin, settings(), [], t)).toEqual([
      "(home)",
      "(favorites)",
      "(requests)",
      "(downloads)",
      "sessions",
      "settings",
    ]);
  });

  test("Sessions is the same row in the sidebar and in More", () => {
    // pass-03 F-72 moved it out of the top bar; the two lists have to agree
    // about where it goes and what it is called.
    const inSidebar = flattenSidebar(
      buildSidebarItems(admin, settings(), [], t),
    ).find((item) => item.key === "sessions");
    const inMore = buildMoreItems(admin, settings(), t)
      .flatMap((group) => group.items)
      .find((item) => item.key === "sessions");

    expect(inSidebar).toEqual(inMore);
    expect(inSidebar?.route.pathname).toBe("/sessions");
  });

  test("a member is offered Sessions nowhere", () => {
    expect(keys(member, settings(), [], t)).not.toContain("sessions");
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
    //
    // Home is the exception and has to be. Its address really *is* `/`, and because every group
    // has an `index`, `replace("/")` resolves inside whichever group you are already in --
    // pressing Home from a library landed on the library grid. So Home alone carries the fully
    // qualified path; the address bar still reads `/`.
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
      "(home)": "/(auth)/(tabs)/(home)/",
      "(favorites)": "/favorites",
      "(watchlists)": "/watchlists",
      "(custom-links)": "/links",
      "(requests)": "/requests",
      "(downloads)": "/transfers",
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
    // The first render after sign-in, before either atom has settled. Nothing elevated shows until
    // the user atom says it may, which is the safe direction: a row that appears and then vanishes
    // is worse than one that appears a beat late.
    expect(keys(null, null, null, t)).toEqual([
      "(home)",
      "(favorites)",
      "(requests)",
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

  /**
   * The library rows, which live inside the unlabelled browse block rather than
   * a section of their own. They used to carry a "Libraries" heading; on the
   * usual two-view node that was a word above two rows that already said what
   * they were.
   */
  const libraries = (
    overrides: Partial<SidebarSettings> = {},
    items: BaseItemDto[] = views,
  ) =>
    buildSidebarItems(member, settings(overrides), items, t)
      .find((section) => section.key === "primary")
      ?.items.filter((item) => item.libraryId !== undefined) ?? [];

  test("one row per view, in the server's order, books excluded", () => {
    expect(libraries().map((item) => item.label)).toEqual([
      "Movies",
      "Shows",
      "Songs",
      "Live TV",
    ]);
  });

  test("they sit between Home and Favorites, under no heading", () => {
    const primary = buildSidebarItems(member, settings(), views, t).find(
      (section) => section.key === "primary",
    );

    expect(primary?.title).toBeUndefined();
    expect(primary?.items.map((item) => item.key)).toEqual([
      "(home)",
      "library:m",
      "library:t",
      "library:s",
      "library:l",
      "(favorites)",
    ]);
  });

  test("a library the user hid is not a nav item either", () => {
    expect(
      libraries({ hiddenLibraries: ["m", "l"] }).map((i) => i.key),
    ).toEqual(["library:t", "library:s"]);
  });

  test("nothing to list leaves Home and Favorites, not an empty heading", () => {
    const browse = (items: BaseItemDto[] | undefined) =>
      buildSidebarItems(member, settings(), items, t)
        .find((section) => section.key === "primary")
        ?.items.map((item) => item.key);

    expect(browse([])).toEqual(["(home)", "(favorites)"]);
    expect(browse([view("a", "Audiobooks", "books")])).toEqual([
      "(home)",
      "(favorites)",
    ]);
    // Still in flight: the query has not answered yet.
    expect(browse(undefined)).toEqual(["(home)", "(favorites)"]);
  });

  test("glyphs come from the collection type, not from one library icon", () => {
    expect(libraries().map((item) => item.icon)).toEqual([
      { set: "ionicons", name: "film" },
      { set: "ionicons", name: "tv" },
      { set: "ionicons", name: "musical-notes" },
      { set: "ionicons", name: "tv" },
    ]);
  });

  test("music and live TV open their own screens, everything else the grid", () => {
    const routes = Object.fromEntries(
      libraries().map((item) => [item.key, item.route]),
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

// ---------------------------------------------------------------------------
// The three bands
// ---------------------------------------------------------------------------

describe("buildSidebarItems / bands", () => {
  test("a member gets browse and Requests and nothing else", () => {
    expect(
      buildSidebarItems(member, settings(), [], t).map((s) => s.key),
    ).toEqual(["primary", "requests", "footer"]);
  });

  test("an administrator gets a third band, last before the footer", () => {
    const sections = buildSidebarItems(admin, settings(), [], t);

    expect(sections.map((s) => s.key)).toEqual([
      "primary",
      "requests",
      "server",
      "footer",
    ]);

    const server = sections.find((s) => s.key === "server");
    expect(server?.items.map((i) => i.key)).toEqual([
      "(downloads)",
      "sessions",
    ]);
  });

  test("every band is separated by a rule, and none carries a heading", () => {
    // The administrator band had "SERVER" over it for about an hour. Dan: "lets
    // drop SERVER title from the sidebar list - just a separator" -- one word
    // over one band of three reads as a label for the whole lower half.
    const sections = buildSidebarItems(admin, settings(), [], t);

    expect(sections.filter((s) => s.divider).map((s) => s.key)).toEqual([
      "requests",
      "server",
    ]);
    for (const section of sections) {
      expect(section.title).toBeUndefined();
    }
  });

  test("Users is offered on neither surface", () => {
    // It is Settings then Users & access now. Both rows used to point at
    // "/users", which is a redirect into the settings tree.
    expect(keys(admin, settings(), [], t)).not.toContain("users");
    expect(
      buildMoreItems(admin, settings(), t).flatMap((g) =>
        g.items.map((i) => i.key),
      ),
    ).not.toContain("users");
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

  test("Sessions beats Home, though it lives inside the Home stack", () => {
    expect(at(["(auth)", "(tabs)", "(home)", "sessions", "index"])).toBe(
      "sessions",
    );
  });

  test("Settings wins on its own, and loses to the longer match", () => {
    expect(at(["(auth)", "(tabs)", "(home)", "settings"])).toBe("settings");
    expect(
      at(["(auth)", "(tabs)", "(home)", "settings", "network", "page"]),
    ).toBe("settings");
    // Users is a settings category now rather than a section of its own, so
    // Settings is the row that lights for it and no second row can claim it.
    expect(at(["(auth)", "(tabs)", "(home)", "settings", "users"])).toBe(
      "settings",
    );
  });

  test("a route in no tab at all lights nothing", () => {
    expect(at(["(auth)", "player", "direct-player"])).toBeUndefined();
  });

  test("a details page never claims the tab expo-router guessed for it", () => {
    // pass-02 F-26. `/items/page?id=…` typed or pasted cold carries no group,
    // and expo-router resolves the shared
    // `(home,libraries,search,favorites,watchlists)` group alphabetically — so
    // this is the exact segment list a deep-linked film produces, and it used
    // to light "Favorites" on a page showing Nosferatu.
    expect(
      at(["(auth)", "(tabs)", "(favorites)", "items", "page"]),
    ).toBeUndefined();
    expect(
      at(["(auth)", "(tabs)", "(favorites)", "series", "[id]"]),
    ).toBeUndefined();
    expect(
      at(["(auth)", "(tabs)", "(home)", "persons", "[personId]"]),
    ).toBeUndefined();
  });

  test("...but it still lights the library it was opened from", () => {
    // Navigating in-app keeps the library screen underneath in the stack, so
    // its `libraryId` is still in the global params — the more specific rule
    // above wins and the Movies row stays lit behind the film.
    expect(at(["(auth)", "(tabs)", "(libraries)", "items", "page"], "m")).toBe(
      "library:m",
    );
  });

  test("the Favorites tab root itself is unaffected", () => {
    expect(at(["(auth)", "(tabs)", "(favorites)", "index"])).toBe(
      "(favorites)",
    );
  });
});

// ---------------------------------------------------------------------------
// The phone's More tab (pass-01 F-08)
// ---------------------------------------------------------------------------

const moreKeys = (...args: Parameters<typeof buildMoreItems>): string[] =>
  buildMoreItems(...args).flatMap((group) => group.items.map((i) => i.key));

describe("buildMoreItems", () => {
  // The two lists agree about who sees what, which is why they are built next to each other:
  // `browse` and `app` are drawn for everybody, `admin` only for an administrator.
  test("a member gets Favorites and Settings and no admin group", () => {
    expect(moreKeys(member, settings(), t)).toEqual([
      "(favorites)",
      "settings",
    ]);
    expect(buildMoreItems(member, settings(), t).map((g) => g.key)).toEqual([
      "browse",
      "app",
    ]);
  });

  test("an administrator gets Transfers and Sessions, in their own group", () => {
    const groups = buildMoreItems(admin, settings(), t);

    expect(groups.map((group) => group.key)).toEqual([
      "browse",
      "admin",
      "app",
    ]);
    expect(
      groups.find((group) => group.key === "admin")?.items.map((i) => i.key),
    ).toEqual(["(downloads)", "sessions"]);
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
    expect(moreKeys(member, settings(), t)).not.toContain("(downloads)");
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
    expect(moreKeys(null, null, t)).toEqual(["(favorites)", "settings"]);
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
