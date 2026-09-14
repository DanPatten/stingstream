import { describe, expect, test } from "bun:test";
import type { MeshNodePeer } from "@/lib/stingstream/meshApi";
import { buildInviteLink, parseLink } from "./connectionLink";
import { peerAddress } from "./serverList";

const fragmentOf = (url: string) => url.slice(url.indexOf("#"));

describe("an invite link carries the address of the server that made it", () => {
  test("round-trips as an origin, through a forward", () => {
    const url = buildInviteLink("http://127.0.0.1:8802", {
      code: "C0DE",
      node: "n1",
      server: "dan main",
      address: "https://meals.danha.top/settings/servers",
      forwarded: true,
    })!;
    const parsed = parseLink(fragmentOf(url));
    expect(parsed?.kind).toBe("invite");
    expect(parsed?.kind === "invite" && parsed.invite.address).toBe(
      "https://meals.danha.top",
    );
  });

  test("an address that is not a web origin is left out", () => {
    const url = buildInviteLink("https://a.example", {
      code: "x",
      node: "",
      server: "",
      address: "javascript:alert(1)",
    })!;
    expect(url).not.toContain("addr=");
  });
});

describe("peerAddress", () => {
  const peer = (over: Partial<MeshNodePeer>): MeshNodePeer => ({
    group: "g",
    node: "n",
    serverName: "dan main",
    online: true,
    firstSeen: "",
    ...over,
  });

  test("the address saved for the connection wins", () => {
    expect(peerAddress(peer({ address: "https://meals.danha.top" }))).toBe(
      "https://meals.danha.top",
    );
  });

  test("nothing saved and nothing announced is no address", () => {
    expect(peerAddress(peer({}))).toBeNull();
  });
});
