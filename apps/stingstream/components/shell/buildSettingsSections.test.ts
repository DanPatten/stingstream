import { describe, expect, test } from "bun:test";
import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import {
  buildSettingsGroups,
  flattenSettings,
  type SettingsRow,
} from "./buildSettingsSections";

// The rules of the Settings screen: who sees which row. None of it needs React,
// a navigator or the Jellyfin SDK — which is why `buildSettingsGroups` is a
// plain function and not a hook, exactly as `buildSidebarItems` is.

/** Keys are echoed back, so an assertion names the key and not a translation. */
const t = (key: string) => key;

const client: UserDto = { Id: "u1", Name: "Sam" };
const admin: UserDto = {
  Id: "u2",
  Name: "Dan",
  Policy: { IsAdministrator: true } as UserDto["Policy"],
};

const rowKeys = (user: UserDto | null | undefined): string[] =>
  flattenSettings(buildSettingsGroups(user, t)).map((row) => row.key);

const groupKeys = (user: UserDto | null | undefined): string[] =>
  buildSettingsGroups(user, t).map((group) => group.key);

describe("buildSettingsGroups", () => {
  test("a client gets the rows that are about their own app, and nothing else", () => {
    expect(rowKeys(client)).toEqual([
      "appearance",
      "playback-controls",
      "audio-subtitles",
      "music",
      "my-server",
      "this-device",
    ]);
  });

  test("an administrator gets all three groups", () => {
    expect(groupKeys(admin)).toEqual(["general", "sharing", "server"]);
    expect(rowKeys(admin)).toEqual([
      "appearance",
      "playback-controls",
      "audio-subtitles",
      "music",
      "network",
      "plugins",
      "servers",
      "my-server",
      "this-device",
      "users",
      "server-settings",
      "libraries-and-transcoding",
      "server-status",
      "logs",
    ]);
  });

  // The three Dan asked for, named one at a time so a regression says which.
  test.each(["servers", "plugins", "network"])(
    "%s is not offered to a client",
    (key) => {
      expect(rowKeys(client)).not.toContain(key);
      expect(rowKeys(admin)).toContain(key);
    },
  );

  test("the Server group is absent for a client rather than empty", () => {
    // A heading with nothing under it reads as a screen that failed to load.
    expect(groupKeys(client)).toEqual(["general", "sharing"]);
  });

  // The one row in Sharing a client keeps: it is a fact about the phone in
  // their hand, not about anybody's server.
  test("This device survives the gate", () => {
    const rows = flattenSettings(buildSettingsGroups(client, t));
    const device = rows.find((row) => row.key === "this-device");
    expect(device?.kind).toBe("deviceStatus");
    // Its detail is computed at render from `useMeshSummary`, so the builder
    // must not invent one.
    expect(device?.detail).toBeUndefined();
    expect(device?.route).toBeUndefined();
  });

  test("no user at all is treated as no administrator", () => {
    expect(rowKeys(null)).toEqual(rowKeys(client));
    expect(rowKeys(undefined)).toEqual(rowKeys(client));
    // A user object with no policy at all is the same answer, not a crash.
    expect(rowKeys({ Id: "u3", Name: "Alex" })).toEqual(rowKeys(client));
  });

  test("every link row has a route and every other row has none", () => {
    const rows: SettingsRow[] = flattenSettings(buildSettingsGroups(admin, t));
    for (const row of rows) {
      if (row.kind === "link") expect(row.route).toBeTruthy();
      else expect(row.route).toBeUndefined();
    }
  });

  test("routes are unique, so a key can never light two rows", () => {
    const routes = flattenSettings(buildSettingsGroups(admin, t))
      .map((row) => row.route)
      .filter(Boolean);
    expect(new Set(routes).size).toBe(routes.length);
  });
});

describe("the server a client runs themselves", () => {
  // The row Dan asked to keep when Servers went behind the gate: that one is about *this* server
  // and is the owner's business, this one is about theirs.
  test("is offered to everybody, administrator or not", () => {
    expect(rowKeys(client)).toContain("my-server");
    expect(rowKeys(admin)).toContain("my-server");
  });

  test("sits in Sharing, beside the row it replaces for a client", () => {
    const sharing = buildSettingsGroups(client, t).find(
      (group) => group.key === "sharing",
    );
    expect(sharing?.rows.map((row) => row.key)).toEqual([
      "my-server",
      "this-device",
    ]);
  });
});
