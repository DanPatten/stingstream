import { describe, expect, test } from "bun:test";
import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import en from "@/translations/en.json";
import {
  buildSettingsCategories,
  flattenCategories,
} from "./buildSettingsCategories";
import {
  buildSettingsSearchIndex,
  SETTINGS_CONTROL_IDS,
  SETTINGS_SEARCH_LIMIT,
  searchSettings,
} from "./settingsSearchIndex";

// The search is the one part of Settings a reader can get *wrong answers* from
// rather than merely fail to find something, so the ranking is pinned rather
// than left to whatever `Array.sort` happened to do.

const member: UserDto = { Id: "u1", Name: "Sam" };
const admin: UserDto = {
  Id: "u2",
  Name: "Dan",
  Policy: { IsAdministrator: true } as UserDto["Policy"],
};

/**
 * The real English catalogue, not an echo of the key.
 *
 * Ranking is about the *words*, so a `t` that returned keys would make every
 * assertion below vacuous — "hardware-acceleration" contains "hardware" whether
 * or not anybody ever wrote the label.
 */
const t = (key: string): string => {
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

const index = (user: UserDto | null) => buildSettingsSearchIndex(user, t);
const find = (user: UserDto | null, query: string) =>
  searchSettings(index(user), query).map((entry) => entry.id);

describe("buildSettingsSearchIndex", () => {
  test("every control names a category the account can actually open", () => {
    const routes = new Set(
      flattenCategories(buildSettingsCategories(admin, t)).map((c) => c.route),
    );

    for (const entry of index(admin)) {
      expect(routes.has(entry.href.split("?")[0] as string)).toBe(true);
    }
  });

  test("every entry has a real label and real keywords", () => {
    // A missing key renders as the key itself, which would look like a control
    // called "home.settings.search.label.https" in the results list.
    for (const entry of index(admin)) {
      expect(entry.label).not.toContain("home.settings.search");
      expect(entry.label.length).toBeGreaterThan(2);
      expect(entry.keywords.length).toBeGreaterThan(1);
      for (const word of entry.keywords) expect(word).toBe(word.toLowerCase());
    }
  });

  test("every category contributes at least one control", () => {
    // A category with nothing indexed is one the search can only reach by its
    // own name, which is exactly the page-level behaviour this replaced.
    const covered = new Set(index(admin).map((entry) => entry.categoryKey));
    for (const category of flattenCategories(
      buildSettingsCategories(admin, t),
    )) {
      expect(covered.has(category.key)).toBe(true);
    }
  });

  test("ids are unique, because one is a React key and a focus target", () => {
    expect(new Set(SETTINGS_CONTROL_IDS).size).toBe(
      SETTINGS_CONTROL_IDS.length,
    );
  });

  test("every href carries a focus target, and a tab where the pane has one", () => {
    for (const entry of index(admin)) {
      expect(entry.href).toContain(`focus=${entry.id}`);
    }
    const audio = index(admin).find((e) => e.id === "subtitle-language");
    expect(audio?.href).toBe(
      "/settings/playback?tab=audio&focus=subtitle-language",
    );
  });

  test("a member is never offered a page they cannot open", () => {
    const forMember = index(member).map((entry) => entry.categoryKey);
    expect(forMember).not.toContain("transcoding");
    expect(forMember).not.toContain("users");
    // ...but they keep everything that is theirs.
    expect(forMember).toContain("playback");
    expect(forMember).toContain("servers");
  });

  test("the switch that turns downloading on is reachable by search", () => {
    // Every "Downloading is not set up on this server." notice in the app is
    // trying to reach one control, and that control is now a library's switch:
    // turning a library on is what starts the manager that fills it. A reader
    // who takes the sentence at its word and types "downloading" has to land
    // there, which is a property of the keywords rather than of the id.
    const entry = index(admin).find((e) => e.id === "libraries");
    expect(entry?.categoryKey).toBe("storage");
    expect(entry?.href).toBe("/settings/storage?focus=libraries");
    expect(entry?.keywords).toContain("downloading");
  });

  test("a control can point at a page other than its own category", () => {
    // "Invite a person" is listed under Servers because that is where somebody
    // looks for it, and goes to Users & access because that is where it is.
    const invite = index(admin).find((entry) => entry.id === "invite-person");
    expect(invite?.categoryKey).toBe("servers");
    expect(invite?.href.startsWith("/settings/users")).toBe(true);
  });
});

describe("searchSettings", () => {
  test("the word nobody sees on screen still finds the control", () => {
    // The whole reason this is control-level: "nvenc" appears in no label, on
    // no page, and is what somebody with an Nvidia card types.
    expect(find(admin, "nvenc")[0]).toBe("hardware-acceleration");
    expect(find(admin, "transcode")).toContain("hardware-acceleration");
    expect(find(admin, "x-forwarded")[0]).toBe("known-proxies");
    expect(find(admin, "cc")).toContain("subtitle-language");
    expect(find(admin, "upnp")[0]).toBe("port-forwarding");
  });

  test("the words somebody types when nothing is downloading", () => {
    // The reader's vocabulary, not ours: they have just been told downloading
    // is off, so "enable" and "turn on" are as likely as the noun itself.
    expect(find(admin, "downloading")[0]).toBe("libraries");
    expect(find(admin, "usenet")).toContain("download-clients");
    // Whole phrases, because `score` matches the trimmed query as one string
    // against each keyword rather than word by word — so "enable downloading"
    // finds nothing unless somebody wrote that phrase down. "not set up" is
    // the literal sentence the notice shows, which is what a reader who was
    // just told to do something about it has in front of them to copy.
    expect(find(admin, "enable")).toContain("libraries");
    expect(find(admin, "turn on")).toContain("libraries");
    expect(find(admin, "enable downloading")[0]).toBe("libraries");
    expect(find(admin, "turn on downloading")[0]).toBe("libraries");
    expect(find(admin, "not set up")[0]).toBe("libraries");
  });

  test("a label beats a keyword", () => {
    const results = find(admin, "certificate");
    expect(results[0]).toBe("certificate");
  });

  test("an empty query matches nothing rather than everything", () => {
    expect(find(admin, "")).toEqual([]);
    expect(find(admin, "   ")).toEqual([]);
  });

  test("nonsense matches nothing", () => {
    expect(find(admin, "zzzqqq")).toEqual([]);
  });

  test("results are capped, so a broad query is still a list", () => {
    // "a" hits a great many labels and keywords; a dropdown is not a page.
    expect(find(admin, "a").length).toBeLessThanOrEqual(SETTINGS_SEARCH_LIMIT);
  });

  test("case and surrounding space do not matter", () => {
    expect(find(admin, "  NVENC ")[0]).toBe("hardware-acceleration");
  });
});
