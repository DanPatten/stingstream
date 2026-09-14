import { describe, expect, test } from "bun:test";
import {
  buildInviteLink,
  buildStartLink,
  isInviteMaker,
  LINK_PATH,
  parseLink,
} from "./connectionLink";

const NODE = "a".repeat(64);
const fragmentOf = (url: string) => url.slice(url.indexOf("#"));

describe("the invite link", () => {
  test("carries the code in the fragment and round-trips", () => {
    const url = buildInviteLink("https://loft.example/", {
      code: "C0DE+/=",
      node: NODE,
      server: "Dan's Loft & Attic",
    })!;
    expect(url.startsWith(`https://loft.example${LINK_PATH}#`)).toBe(true);
    expect(url.indexOf("?")).toBe(-1);
    expect(parseLink(fragmentOf(url))).toEqual({
      kind: "invite",
      invite: { code: "C0DE+/=", node: NODE, server: "Dan's Loft & Attic" },
    });
  });

  test("no address or no code is no link", () => {
    expect(buildInviteLink(null, { code: "x", node: NODE, server: "" })).toBe(
      null,
    );
    expect(
      buildInviteLink("not a url", { code: "x", node: NODE, server: "" }),
    ).toBe(null);
    expect(
      buildInviteLink("https://a.example", { code: " ", node: "", server: "" }),
    ).toBe(null);
  });

  test("a forwarded link says so", () => {
    const url = buildInviteLink("https://mine.example", {
      code: "x",
      node: "",
      server: "",
      forwarded: true,
    })!;
    const parsed = parseLink(fragmentOf(url));
    expect(parsed?.kind === "invite" && parsed.invite.forwarded).toBe(true);
  });
});

describe("the start link", () => {
  test("round-trips, and only ever carries an origin to return to", () => {
    const url = buildStartLink("http://127.0.0.1:8802", {
      returnTo: "http://127.0.0.1:5173/settings/servers?x=1",
      server: "Loft",
    })!;
    expect(parseLink(fragmentOf(url))).toEqual({
      kind: "start",
      start: { returnTo: "http://127.0.0.1:5173", server: "Loft" },
    });
  });

  test("somewhere that is not a web origin is no link", () => {
    expect(
      buildStartLink("https://b.example", {
        returnTo: "javascript:alert(1)",
        server: "",
      }),
    ).toBe(null);
    expect(parseLink("#start=1&return=file:///etc")).toBe(null);
  });
});

describe("parseLink", () => {
  test("anything else is null", () => {
    expect(parseLink(null)).toBe(null);
    expect(parseLink("#")).toBe(null);
    expect(parseLink("#node=abc")).toBe(null);
  });
});

describe("isInviteMaker", () => {
  test("compares node ids however they are spelled", () => {
    const invite = { code: "x", node: NODE, server: "" };
    expect(isInviteMaker(invite, NODE.toUpperCase())).toBe(true);
    expect(isInviteMaker(invite, "b".repeat(64))).toBe(false);
    // Not knowing this server's id is not being the maker: the reader is asked to connect, and the
    // server that made it refuses its own code if it ever came to that.
    expect(isInviteMaker(invite, null)).toBe(false);
  });

  test("a link with no node id is the maker's until it has been forwarded once", () => {
    expect(isInviteMaker({ code: "x", node: "", server: "" }, NODE)).toBe(true);
    expect(
      isInviteMaker({ code: "x", node: "", server: "", forwarded: true }, NODE),
    ).toBe(false);
  });
});
