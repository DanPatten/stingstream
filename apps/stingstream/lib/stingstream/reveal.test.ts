import { describe, expect, test } from "bun:test";
import {
  fetchRevealCapability,
  NO_REVEAL,
  parseRevealCapability,
  type RevealContext,
  revealFailure,
  revealItem,
  shouldShowReveal,
} from "./reveal";

const YES = { canReveal: true, platform: "windows" } as const;

const ctx = (over: Partial<RevealContext> = {}): RevealContext => ({
  os: "web",
  isTV: false,
  isAdmin: true,
  capability: YES,
  ...over,
});

describe("shouldShowReveal", () => {
  test("an admin in a browser on the server's own machine sees it", () => {
    expect(shouldShowReveal(ctx())).toBe(true);
  });

  test("a member does not, even on the server", () => {
    expect(shouldShowReveal(ctx({ isAdmin: false }))).toBe(false);
  });

  test("a browser elsewhere does not: the node said no", () => {
    expect(shouldShowReveal(ctx({ capability: NO_REVEAL }))).toBe(false);
  });

  test("nothing is drawn before the node has answered", () => {
    expect(shouldShowReveal(ctx({ capability: undefined }))).toBe(false);
  });

  test("never on a phone or a TV", () => {
    expect(shouldShowReveal(ctx({ os: "android" }))).toBe(false);
    expect(shouldShowReveal(ctx({ os: "ios" }))).toBe(false);
    expect(shouldShowReveal(ctx({ isTV: true }))).toBe(false);
  });
});

describe("parseRevealCapability", () => {
  test("yes only when the node says yes and names an OS it knows", () => {
    expect(parseRevealCapability(YES)).toEqual(YES);
    expect(parseRevealCapability({ canReveal: false, platform: null })).toEqual(
      NO_REVEAL,
    );
    expect(
      parseRevealCapability({ canReveal: true, platform: "beos" }),
    ).toEqual(NO_REVEAL);
    expect(parseRevealCapability({ canReveal: "true" })).toEqual(NO_REVEAL);
    expect(parseRevealCapability(null)).toEqual(NO_REVEAL);
    expect(parseRevealCapability("<html>")).toEqual(NO_REVEAL);
  });

  test("a node without the route, or no node at all, is a no", async () => {
    const notFound = (async () =>
      new Response("no", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchRevealCapability("http://n", notFound)).toEqual(
      NO_REVEAL,
    );
    const html = (async () =>
      new Response("<!doctype html>", {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await fetchRevealCapability("http://n", html)).toEqual(NO_REVEAL);
    const down = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await fetchRevealCapability("http://n", down)).toEqual(NO_REVEAL);
  });
});

describe("revealItem", () => {
  test("posts the ids, never a path, with the session's token", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const ok = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    expect(await revealItem("http://n", "tok", "i1", "s1", ok)).toEqual({
      ok: true,
    });
    expect(seen?.url).toBe("http://n/stingstream/reveal");
    expect(seen?.init?.method).toBe("POST");
    expect(JSON.parse(String(seen?.init?.body))).toEqual({
      itemId: "i1",
      mediaSourceId: "s1",
    });
    const headers = (seen?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('MediaBrowser Token="tok"');
  });

  test("a refusal carries the gateway's code", async () => {
    const missing = (async () =>
      Response.json(
        { error: "file_missing", message: "..." },
        { status: 404 },
      )) as unknown as typeof fetch;
    expect(await revealItem("http://n", "t", "i", undefined, missing)).toEqual({
      ok: false,
      code: "file_missing",
    });
  });
});

describe("revealFailure", () => {
  test("known codes get their own line and the rest the general one", () => {
    expect(revealFailure("file_missing")).toBe("file_missing");
    expect(revealFailure("no_local_file")).toBe("remote_file");
    expect(revealFailure("not_local")).toBe("not_here");
    expect(revealFailure("unsupported")).toBe("not_here");
    expect(revealFailure("launch_failed")).toBe("failed");
    expect(revealFailure(undefined)).toBe("failed");
  });
});
