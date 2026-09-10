import { describe, expect, test } from "bun:test";
import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import { ICON_NAMES } from "@/components/common/iconNames";
import {
  buildSettingsCategories,
  categoryForRoute,
  flattenCategories,
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

  test("an administrator gets all three groups, administration last", () => {
    expect(groupKeys(admin)).toEqual(["you", "servers", "administration"]);

    const administration = buildSettingsCategories(admin, t).find(
      (group) => group.key === "administration",
    );
    expect(administration?.categories.map((item) => item.key)).toEqual([
      "users",
      "services",
      "arr_library",
      "storage",
      "quality",
      "files",
      "transcoding",
      "network",
      "notifications",
      "plugins",
      "diagnostics",
    ]);
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
      expect(group?.categories.map((c) => c.key)).toEqual(["servers"]);
    }
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

  test("every category names a real glyph and a scope", () => {
    for (const item of flattenCategories(buildSettingsCategories(admin, t))) {
      expect(ICON_NAMES).toContain(item.icon);
      expect(["device", "account", "server"]).toContain(item.scope);
      expect(item.testID).toBe(`settings-nav-${item.key}`);
    }
  });

  test("no two categories share a glyph", () => {
    // Fourteen rows in one column: a repeated icon there stops being shorthand
    // and starts being noise.
    const icons = flattenCategories(buildSettingsCategories(admin, t)).map(
      (item) => item.icon,
    );
    expect(new Set(icons).size).toBe(icons.length);
  });

  test("everything an administrator configures is server-scoped", () => {
    const administration = buildSettingsCategories(admin, t).find(
      (group) => group.key === "administration",
    );
    for (const item of administration?.categories ?? []) {
      expect(item.scope).toBe("server");
    }
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
    expect(at("/settings/servers/create")).toBe("servers");
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
