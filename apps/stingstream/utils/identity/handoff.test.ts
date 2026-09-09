import { describe, expect, test } from "bun:test";
import {
  AUTHORIZE_PATH,
  buildAuthorizeUrl,
  buildReturnUrl,
  parseAssertion,
  parseAuthorizeRequest,
} from "./handoff";

// The two fragments the cross-server sign-in hops on. Pure string work, pinned here for the same
// reason `inviteLink.test.ts` pins the invite link's: a mangled link is the failure people actually
// hit, and it should produce "this link is incomplete" rather than a crash or a silent wrong answer.

const NODE = "a".repeat(64);

describe("buildAuthorizeUrl", () => {
  test("puts everything in the fragment and nothing in the query", () => {
    const url = buildAuthorizeUrl("https://my-server.example", {
      audience: NODE,
      nonce: "n1",
      returnTo: "https://their-server.example/join",
      serverName: "Their Loft",
    });

    expect(url).toBeTruthy();
    // The important assertion in this file: a browser never sends a fragment, so nothing here
    // reaches an access log.
    expect(url!.indexOf("?")).toBe(-1);
    expect(url!.startsWith(`https://my-server.example${AUTHORIZE_PATH}#`)).toBe(
      true,
    );
  });

  test("a trailing slash on the origin does not double up", () => {
    const url = buildAuthorizeUrl("https://my-server.example/", {
      audience: NODE,
      nonce: "n1",
      returnTo: "https://their-server.example/join",
    });
    expect(url).toContain("example/authorize#");
    expect(url).not.toContain("example//authorize");
  });

  test("no audience or no nonce is no link", () => {
    // An assertion with no audience would be usable at every server, and one with no nonce would
    // be usable twice. Neither is a link worth building.
    const base = {
      audience: NODE,
      nonce: "n1",
      returnTo: "https://x.example/join",
    };
    expect(buildAuthorizeUrl("", base)).toBe(null);
    expect(
      buildAuthorizeUrl("https://x.example", { ...base, audience: "" }),
    ).toBe(null);
    expect(
      buildAuthorizeUrl("https://x.example", { ...base, nonce: " " }),
    ).toBe(null);
  });
});

describe("parseAuthorizeRequest", () => {
  test("round-trips everything, including values that need escaping", () => {
    const request = {
      audience: NODE,
      nonce: "n+1/2=",
      returnTo: "https://their-server.example/join?x=1&y=2",
      serverName: "Dan's Loft & Attic",
      invite: "tok=en",
    };
    const url = buildAuthorizeUrl("https://my-server.example", request)!;
    const parsed = parseAuthorizeRequest(url.slice(url.indexOf("#")));

    expect(parsed).toEqual(request);
  });

  test("a fragment with no audience or nonce is refused", () => {
    expect(parseAuthorizeRequest("#return=https://x.example")).toBe(null);
    expect(parseAuthorizeRequest(`#aud=${NODE}`)).toBe(null);
    expect(parseAuthorizeRequest("#nonce=n1")).toBe(null);
  });

  test("nothing at all is refused rather than guessed at", () => {
    // Almost always a chat client that stripped the fragment. "This link is incomplete" is a
    // better answer than treating the bare URL as a request.
    expect(parseAuthorizeRequest(null)).toBe(null);
    expect(parseAuthorizeRequest(undefined)).toBe(null);
    expect(parseAuthorizeRequest("")).toBe(null);
    expect(parseAuthorizeRequest("#")).toBe(null);
  });

  test("a mangled escape drops its own pair rather than throwing", () => {
    // `decodeURIComponent("%")` throws; a half-copied link should not take the screen with it.
    const parsed = parseAuthorizeRequest(
      `#aud=${NODE}&nonce=n1&server=%E0%A4%A`,
    );
    expect(parsed?.audience).toBe(NODE);
    expect(parsed?.serverName).toBeUndefined();
  });

  test("the optional halves come back undefined rather than empty", () => {
    const parsed = parseAuthorizeRequest(
      `#aud=${NODE}&nonce=n1&server=&invite=`,
    );
    expect(parsed?.serverName).toBeUndefined();
    expect(parsed?.invite).toBeUndefined();
  });
});

describe("buildReturnUrl", () => {
  test("the assertion rides in the fragment", () => {
    const url = buildReturnUrl("https://their-server.example/join", "SIGNED")!;
    expect(url).toBe("https://their-server.example/join#assertion=SIGNED");
    expect(url.indexOf("?")).toBe(-1);
  });

  test("whatever was already in the fragment is replaced, not appended", () => {
    // What was there is the request that has just been answered. Leaving it would mean the page on
    // the other end could read a spent nonce back as a fresh one.
    const url = buildReturnUrl(
      "https://their-server.example/join#aud=x&nonce=y",
      "SIGNED",
    );
    expect(url).toBe("https://their-server.example/join#assertion=SIGNED");
  });

  test("nowhere to go, or nothing to send, is no link", () => {
    expect(buildReturnUrl("", "SIGNED")).toBe(null);
    expect(buildReturnUrl("https://x.example/join", "")).toBe(null);
  });
});

describe("parseAssertion", () => {
  test("reads one back out", () => {
    expect(parseAssertion("#assertion=SIGNED")).toBe("SIGNED");
  });

  test("an assertion with base64url padding characters survives", () => {
    const signed = "abc-_123";
    const url = buildReturnUrl("https://x.example/join", signed)!;
    expect(parseAssertion(url.slice(url.indexOf("#")))).toBe(signed);
  });

  test("anything else is null", () => {
    expect(parseAssertion(null)).toBe(null);
    expect(parseAssertion("#")).toBe(null);
    expect(parseAssertion("#nonce=n1")).toBe(null);
  });
});
