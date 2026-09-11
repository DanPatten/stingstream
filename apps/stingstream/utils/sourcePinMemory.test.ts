import { beforeEach, describe, expect, test } from "bun:test";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import { clearMmkv, stubMmkv } from "@/test-utils/mmkv";

stubMmkv();

const { clearSourcePin, getSourcePin, rememberSourcePin, sourcePinKey } =
  await import("./sourcePinMemory");

beforeEach(clearMmkv);

describe("sourcePinKey", () => {
  test("files an episode under its series", () => {
    // "Play this show from the attic box" is one decision, not one per episode. An episode that
    // box happens not to hold falls back to Auto on its own without disturbing the rest.
    const episode = {
      Id: "e1",
      Type: "Episode",
      SeriesId: "s1",
    } as BaseItemDto;
    expect(sourcePinKey(episode)).toBe("s1");
  });

  test("falls back to the episode's own id when it names no series", () => {
    const orphan = { Id: "e1", Type: "Episode" } as BaseItemDto;
    expect(sourcePinKey(orphan)).toBe("e1");
  });

  test("files a movie and a series under themselves", () => {
    expect(sourcePinKey({ Id: "m1", Type: "Movie" } as BaseItemDto)).toBe("m1");
    expect(sourcePinKey({ Id: "s1", Type: "Series" } as BaseItemDto)).toBe(
      "s1",
    );
  });

  test("has no key for nothing", () => {
    expect(sourcePinKey(null)).toBeNull();
    expect(sourcePinKey(undefined)).toBeNull();
    expect(sourcePinKey({ Type: "Movie" } as BaseItemDto)).toBeNull();
  });
});

describe("pins", () => {
  test("round-trips a peer", () => {
    rememberSourcePin("m1", { node: "ABCDEF", serverName: "Attic PC" });
    expect(getSourcePin("m1")).toMatchObject({
      node: "ABCDEF",
      serverName: "Attic PC",
    });
  });

  test("a pin on this server is not the same as no pin at all", () => {
    // `node: null` means "always use the copy here", which is a real choice and has to survive a
    // round trip as something other than undefined — otherwise choosing it would read as Auto.
    rememberSourcePin("m1", { node: null, fileHash: "abc" });
    const pin = getSourcePin("m1");
    expect(pin).toBeDefined();
    expect(pin?.node).toBeNull();
    expect(pin?.fileHash).toBe("abc");

    expect(getSourcePin("m2")).toBeUndefined();
  });

  test("a second pin replaces the first", () => {
    rememberSourcePin("m1", { node: "aaa", serverName: "Attic PC" });
    rememberSourcePin("m1", { node: "bbb", serverName: "Loft" });
    expect(getSourcePin("m1")?.node).toBe("bbb");
  });

  test("clearing goes back to Auto", () => {
    rememberSourcePin("m1", { node: "aaa" });
    clearSourcePin("m1");
    expect(getSourcePin("m1")).toBeUndefined();
  });

  test("no key means no write and no read", () => {
    rememberSourcePin(null, { node: "aaa" });
    expect(getSourcePin(null)).toBeUndefined();
    expect(getSourcePin("")).toBeUndefined();
  });

  test("evicts the least recently pinned past the cap", () => {
    // 200 is the cap. Writing 205 must leave 200, and must keep the newest.
    for (let i = 0; i < 205; i++) {
      rememberSourcePin(`m${i}`, { node: `n${i}` });
    }

    expect(getSourcePin("m204")).toBeDefined();
    expect(getSourcePin("m0")).toBeUndefined();
  });
});
