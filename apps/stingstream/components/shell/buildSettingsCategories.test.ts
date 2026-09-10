import { describe, expect, test } from "bun:test";
import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import { ICON_NAMES } from "@/components/common/iconNames";
import en from "@/translations/en.json";
import {
  buildSettingsCategories,
  categoryForRoute,
  flattenCategories,
  settingsNavIntent,
  settingsPath,
} from "./buildSettingsCategories";

// The rules of the Settings screen, which is the only part of it with rules in
// it: who sees which category, in what order, and what each one claims to
// change. None of it needs React, a navigator or the Jellyfin SDK.

/** Keys are echoed back, so an assertion names the key and not a translation. */
const t = (key: string) => key;

const member: UserDto = { Id: "u1", Name: "Sam" };
const admin: UserDto = {
  Id: "u2",
  Name: "Dan",
  Policy: { IsAdministrator: true } as UserDto["Policy"],
};

const groupKeys = (user: UserDto | null) =>
  buildSettingsCategories(user, t).map((group) => group.key);

const categoryKeys = (user: UserDto | null) =>
  flattenCategories(buildSettingsCategories(user, t)).map((item) => item.key);

describe("buildSettingsCategories", () => {
  test("a member gets what is theirs and the Servers page, and nothing else", () => {
    expect(groupKeys(member)).toEqual(["you", "servers"]);
    expect(categoryKeys(member)).toEqual([
      "profile",
      "appearance",
      "playback",
      "about",
      "servers",
    ]);
  });

  test("an administrator gets every group, administration last", () => {
    expect(groupKeys(admin)).toEqual([
      "you",
      "servers",
      "downloading",
      "administration",
    ]);

    const administration = buildSettingsCategories(admin, t).find(
      (group) => group.key === "administration",
    );
    expect(administration?.categories.map((item) => item.key)).toEqual([
      "users",
      "storage",
      "transcoding",
      "network",
      "notifications",
      "plugins",
      "diagnostics",
    ]);
  });

  test("getting hold of something is its own group, not four rows of admin", () => {
    // The ones that answer "how does something I do not have get here" left
    // `administration` together: that group is the machine, this one is a
    // subject somebody sits down to configure. Downloading leads because it is
    // the only one that can be switched off, which makes it the answer to
    // "why is none of the rest of this doing anything".
    const downloading = buildSettingsCategories(admin, t).find(
      (group) => group.key === "downloading",
    );
    expect(downloading?.categories.map((item) => item.key)).toEqual([
      "downloading",
      "arr_library",
      "services",
      "quality",
      "files",
    ]);
  });

  test("the downloading group is absent for a member, not empty", () => {
    expect(groupKeys(member)).not.toContain("downloading");
  });

  test("the administration group is absent for a member, not empty", () => {
    // A heading with nothing under it is not a group -- and an empty one would
    // also tell a member exactly what they are not allowed to see.
    expect(groupKeys(member)).not.toContain("administration");
  });

  test("no user at all is treated as no administrator", () => {
    // The first render after sign-in, before the user atom has settled. Nothing
    // elevated appears until it says it may: a category that shows and then
    // vanishes is worse than one that arrives a beat late.
    expect(groupKeys(null)).toEqual(["you", "servers"]);
  });

  test("Servers is offered to everybody, in its own group", () => {
    // The page is half an administrator's (this server and its links) and half
    // everybody's (the server the reader runs themselves), so gating it would
    // take away the one federation decision a member still gets to make.
    for (const user of [member, admin]) {
      const group = buildSettingsCategories(user, t).find(
        (g) => g.key === "servers",
      );
      expect(group?.categories.map((c) => c.key)).toContain("servers");
    }
  });

  test("Domains sits beside Servers, and only for an administrator", () => {
    // Same group, because it is the same subject: where people reach this
    // server. Administrator-only anyway, because every call behind it needs
    // elevation -- a row that can only fail is worse than no row.
    const groupFor = (user: UserDto) =>
      buildSettingsCategories(user, t)
        .find((g) => g.key === "servers")
        ?.categories.map((c) => c.key);

    expect(groupFor(admin)).toEqual(["servers", "domains"]);
    expect(groupFor(member)).toEqual(["servers"]);
    expect(categoryKeys(member)).not.toContain("domains");
  });

  test("every category has a unique route inside /settings", () => {
    // Two categories sharing an address means one of them can never be the lit
    // row -- the bug that got the old Sharing screen its two URLs.
    const routes = flattenCategories(buildSettingsCategories(admin, t)).map(
      (item) => item.route,
    );

    expect(new Set(routes).size).toBe(routes.length);
    for (const route of routes)
      expect(route.startsWith("/settings/")).toBe(true);
  });

  test("every category names a real glyph", () => {
    for (const item of flattenCategories(buildSettingsCategories(admin, t))) {
      expect(ICON_NAMES).toContain(item.icon);
      expect(item.testID).toBe(`settings-nav-${item.key}`);
    }
  });

  test("no two categories share a glyph", () => {
    // Every row in one column: a repeated icon there stops being shorthand and
    // starts being noise.
    const icons = flattenCategories(buildSettingsCategories(admin, t)).map(
      (item) => item.icon,
    );
    expect(new Set(icons).size).toBe(icons.length);
  });

  test("a label and its hint are two different strings", () => {
    // Guards the `home.settings.nav.<key>` / `<key>_hint` pair: a missing hint
    // key would otherwise render as the label repeated under itself.
    for (const item of flattenCategories(buildSettingsCategories(admin, t))) {
      expect(item.detail).not.toBe(item.label);
      expect(item.detail).toBe(`home.settings.nav.${item.key}_hint`);
    }
  });
});

describe("categoryForRoute", () => {
  const groups = buildSettingsCategories(admin, t);
  const at = (pathname: string) => categoryForRoute(groups, pathname)?.key;

  test("a category's own route", () => {
    expect(at("/settings/transcoding")).toBe("transcoding");
    expect(at("/settings/profile")).toBe("profile");
  });

  test("a page inside a category still lights it", () => {
    expect(at("/settings/servers/join")).toBe("servers");
    expect(at("/settings/appearance/hide-libraries")).toBe("appearance");
  });

  test("the search's own ?focus= query does not stop a match", () => {
    expect(at("/settings/transcoding?focus=hardware-acceleration")).toBe(
      "transcoding",
    );
  });

  test("a trailing slash does not stop a match", () => {
    expect(at("/settings/network/")).toBe("network");
  });

  test("the landing page itself lights nothing", () => {
    expect(at("/settings")).toBeUndefined();
    expect(at("/")).toBeUndefined();
  });

  test("a category a member cannot see never lights for them", () => {
    expect(
      categoryForRoute(
        buildSettingsCategories(member, t),
        "/settings/transcoding",
      ),
    ).toBeUndefined();
  });
});

describe("the hints fit the column they are drawn in", () => {
  // Read the real catalogue, not an echo of the key: the rule is about the
  // words, and `home.settings.nav.storage_hint` is longer than any sentence.
  const real = (key: string): string => {
    const value = key
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object"
            ? (node as Record<string, unknown>)[part]
            : undefined,
        en,
      );
    return typeof value === "string" ? value : key;
  };

  /**
   * Dan's rule, in one number: *"if an elipsise is needed your description is
   * too long"*.
   *
   * The navigation column is `SETTINGS_NAV_WIDTH` wide, less 22 px of padding,
   * an 18 px glyph and a 10 px gap — about 238 px of text, over the two lines
   * `SettingsNavItem` allows, at the `micro` size. 40 characters is comfortably
   * inside that at every breakpoint and leaves a translator some room; the
   * longest hint in English is 33.
   */
  const MAX_HINT = 40;

  test("no category hint can reach an ellipsis", () => {
    for (const item of flattenCategories(
      buildSettingsCategories(admin, real),
    )) {
      expect({ key: item.key, length: item.detail.length }).toEqual({
        key: item.key,
        length: Math.min(item.detail.length, MAX_HINT),
      });
    }
  });

  test("every label is short enough to read at a glance", () => {
    // Two lines are allowed here too, but a label is a name and a name that
    // needs two lines is a description wearing a label's clothes.
    for (const item of flattenCategories(
      buildSettingsCategories(admin, real),
    )) {
      expect(item.label.length).toBeLessThanOrEqual(28);
    }
  });
});

describe("settingsPath", () => {
  test("a query and a trailing slash are not a different page", () => {
    expect(settingsPath("/settings/network")).toBe("/settings/network");
    expect(settingsPath("/settings/network/")).toBe("/settings/network");
    expect(settingsPath("/settings/network//")).toBe("/settings/network");
    expect(
      settingsPath("/settings/transcoding?focus=hardware-acceleration"),
    ).toBe("/settings/transcoding");
    expect(settingsPath("/settings/transcoding/?focus=x")).toBe(
      "/settings/transcoding",
    );
    expect(settingsPath("")).toBe("");
    expect(settingsPath("/")).toBe("");
  });
});

describe("settingsNavIntent", () => {
  // Which row is *lit* is a prefix match, and that is right: /settings/servers/this
  // is Servers. Clicking it used to be answered the same way, so on every page
  // inside a category the row that should walk you back up was the one dead link
  // on the screen. Lighting is a prefix; clicking is an address.
  const groups = buildSettingsCategories(admin, t);

  test("a page inside a category walks back up to it", () => {
    // The reported bug, in one line: standing on This server, Servers did nothing.
    expect(
      settingsNavIntent("/settings/servers", "/settings/servers/this"),
    ).toBe("navigate");
    expect(
      settingsNavIntent("/settings/servers", "/settings/servers/join"),
    ).toBe("navigate");
    expect(
      settingsNavIntent("/settings/servers", "/settings/servers/abc123"),
    ).toBe("navigate");
    expect(
      settingsNavIntent(
        "/settings/appearance",
        "/settings/appearance/hide-libraries",
      ),
    ).toBe("navigate");
    expect(
      settingsNavIntent("/settings/plugins", "/settings/plugins/marlin-search"),
    ).toBe("navigate");
  });

  test("no category is a dead row from a page inside it", () => {
    // The sweep, so a category added later cannot reintroduce this one page at a
    // time -- the same reason NoSeatFacesAwayFromItsTable sweeps every room.
    for (const item of flattenCategories(groups)) {
      expect({
        key: item.key,
        intent: settingsNavIntent(item.route, `${item.route}/anything`),
      }).toEqual({ key: item.key, intent: "navigate" });
      expect(settingsNavIntent(item.route, `${item.route}/a/b`)).toBe(
        "navigate",
      );
      expect(settingsNavIntent(item.route, `${item.route}/a?focus=x`)).toBe(
        "navigate",
      );
    }
  });

  test("the row's own URL is the only no-op", () => {
    expect(settingsNavIntent("/settings/servers", "/settings/servers")).toBe(
      "none",
    );
    expect(settingsNavIntent("/settings/network", "/settings/network/")).toBe(
      "none",
    );
    expect(
      settingsNavIntent(
        "/settings/transcoding",
        "/settings/transcoding?focus=hardware-acceleration",
      ),
    ).toBe("none");
  });

  test("a different category replaces, so six of them are never six screens", () => {
    // Categories are siblings of one screen. `navigate` would push here, because
    // a sibling is not in the stack -- which is the six-stacked-screens bug
    // `SettingsNav` records.
    expect(
      settingsNavIntent("/settings/playback", "/settings/servers/this"),
    ).toBe("replace");
    expect(settingsNavIntent("/settings/about", "/settings/profile")).toBe(
      "replace",
    );
    expect(settingsNavIntent("/settings/profile", "/settings")).toBe("replace");
  });

  test("a shared prefix is not the same tree", () => {
    // `/settings/server` is a redirect stub living next door to
    // `/settings/servers`; a bare startsWith would swallow it.
    expect(settingsNavIntent("/settings/server", "/settings/servers")).toBe(
      "replace",
    );
    expect(settingsNavIntent("/settings/servers", "/settings/server")).toBe(
      "replace",
    );
  });

  test("a page that declares itself part of a category counts as inside it", () => {
    // `/settings/logs` is About's by its own `categoryKey`, and About is one push
    // below it, so that click is a walk back up too -- which the URL alone cannot
    // see.
    expect(settingsNavIntent("/settings/about", "/settings/logs", true)).toBe(
      "navigate",
    );
    expect(settingsNavIntent("/settings/about", "/settings/logs")).toBe(
      "replace",
    );
    // ...and the row you are standing on stays a no-op regardless.
    expect(settingsNavIntent("/settings/about", "/settings/about", true)).toBe(
      "none",
    );
  });
});
