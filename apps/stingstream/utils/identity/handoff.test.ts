import { describe, expect, test } from "bun:test";
import {
  AUTHORIZE_PATH,
  buildAuthorizeUrl,
  buildReturnUrl,
  clearFragment,
  parseAssertion,
  parseAuthorizeRequest,
  parseReturnCredential,
  parseReturnInvite,
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

describe("the password credential on the return leg", () => {
  const CREDENTIAL = { salt: "s4lt", verifier: "v3r1f-_", iterations: 100000 };

  test("round-trips beside the assertion", () => {
    const url = buildReturnUrl("https://their-server.example/join", "SIGNED", {
      credential: CREDENTIAL,
    })!;
    const fragment = url.slice(url.indexOf("#"));
    expect(parseAssertion(fragment)).toBe("SIGNED");
    expect(parseReturnCredential(fragment)).toEqual(CREDENTIAL);
  });

  test("an older client sends none, and that reads back as none", () => {
    const url = buildReturnUrl("https://x.example/join", "SIGNED")!;
    expect(url).toBe("https://x.example/join#assertion=SIGNED");
    expect(parseReturnCredential(url.slice(url.indexOf("#")))).toBe(null);
  });

  test("a half-built credential is not sent at all", () => {
    // A salt with no verifier would be a password nobody can reproduce, and a verifier with no
    // round count cannot be checked again once the default moves. Both are worse than nothing,
    // because nothing still leaves the account with a password the server generated.
    for (const partial of [
      { salt: "s4lt", verifier: "", iterations: 100000 },
      { salt: "", verifier: "v", iterations: 100000 },
      { salt: "s4lt", verifier: "v", iterations: 0 },
    ]) {
      const url = buildReturnUrl("https://x.example/join", "SIGNED", {
        credential: partial,
      })!;
      expect(url).toBe("https://x.example/join#assertion=SIGNED");
    }
  });

  test("a fragment missing any part of it is null, not a partial", () => {
    expect(parseReturnCredential("#assertion=S&salt=s4lt")).toBe(null);
    expect(parseReturnCredential("#assertion=S&salt=s4lt&verifier=v")).toBe(
      null,
    );
    expect(
      parseReturnCredential("#assertion=S&salt=s4lt&verifier=v&kdf=nope"),
    ).toBe(null);
    expect(parseReturnCredential(null)).toBe(null);
  });
});

describe("clearFragment", () => {
  test("puts the path back without the fragment, and does nothing off the web", () => {
    const scope = globalThis as {
      history?: unknown;
      location?: unknown;
    };
    const before = { history: scope.history, location: scope.location };
    const calls: string[] = [];
    try {
      scope.history = {
        replaceState: (_a: unknown, _b: string, url: string) => calls.push(url),
      };
      scope.location = { pathname: "/join", search: "?x=1" };
      clearFragment();
      expect(calls).toEqual(["/join?x=1"]);

      // No address bar, so nothing to clear and nothing to throw.
      scope.location = undefined;
      clearFragment();
      expect(calls).toEqual(["/join?x=1"]);
    } finally {
      scope.history = before.history;
      scope.location = before.location;
    }
  });
});

describe("the invite on the return leg", () => {
  // The bug this pins: the invite went out to /authorize and never came back, so a first arrival
  // reached `signin` with nothing to admit it and was told to ask for an invite link — while
  // holding one. Found end to end on two nodes, not by a type.
  test("comes back with the assertion", () => {
    const out = buildAuthorizeUrl("https://mine.example", {
      audience: NODE,
      nonce: "n1",
      returnTo: "https://theirs.example/join",
      invite: "INVITE-TOKEN",
    })!;
    const request = parseAuthorizeRequest(out.slice(out.indexOf("#")))!;
    expect(request.invite).toBe("INVITE-TOKEN");

    const back = buildReturnUrl(request.returnTo, "SIGNED", {
      invite: request.invite,
    })!;
    expect(parseReturnInvite(back.slice(back.indexOf("#")))).toBe(
      "INVITE-TOKEN",
    );
  });

  test("a return leg with no invite reads as none", () => {
    const back = buildReturnUrl("https://x.example/join", "SIGNED")!;
    expect(parseReturnInvite(back.slice(back.indexOf("#")))).toBe(null);
    expect(parseReturnInvite("#assertion=S&invite=")).toBe(null);
    expect(parseReturnInvite(null)).toBe(null);
  });
});
