import { describe, expect, test } from "bun:test";
import { nodeCandidates, typedAddressCandidates } from "./nodeCandidates";

describe("nodeCandidates", () => {
  test("puts the node's gateway port first, then the address discovery actually reported", () => {
    expect(nodeCandidates("http://192.168.1.42:8096")).toEqual([
      "http://192.168.1.42:8790",
      "http://192.168.1.42:8096",
    ]);
  });

  test("does not duplicate when the discovered address is already the gateway", () => {
    expect(nodeCandidates("http://192.168.1.42:8790")).toEqual([
      "http://192.168.1.42:8790",
    ]);
  });

  test("strips a discovered https scheme for the gateway candidate, which is always http", () => {
    expect(nodeCandidates("https://media.local")).toEqual([
      "http://media.local:8790",
      "https://media.local",
    ]);
  });

  test("handles a discovered address with no port", () => {
    expect(nodeCandidates("http://10.0.2.2")).toEqual([
      "http://10.0.2.2:8790",
      "http://10.0.2.2",
    ]);
  });

  test("falls back to the raw input when no host can be parsed", () => {
    expect(nodeCandidates("not a url")).toEqual(["not a url"]);
  });
});

describe("typedAddressCandidates", () => {
  test("assumes the gateway port for a bare LAN address, and tries it first", () => {
    expect(typedAddressCandidates("192.168.0.16")).toEqual([
      "192.168.0.16:8790",
      "192.168.0.16",
    ]);
  });

  test("does the same for a .local name and for a bare hostname", () => {
    expect(typedAddressCandidates("attic.local")).toEqual([
      "attic.local:8790",
      "attic.local",
    ]);
    expect(typedAddressCandidates("attic")).toEqual(["attic:8790", "attic"]);
  });

  // A domain is far more likely to be a tunnel or a reverse proxy on 443, and probing 8790 there
  // first spends a timeout to learn nothing.
  test("tries a real domain as typed first, and the gateway port only as a fallback", () => {
    expect(typedAddressCandidates("https://media.example.com")).toEqual([
      "https://media.example.com",
      "https://media.example.com:8790",
    ]);
  });

  test("keeps a typed scheme when it assumes the port", () => {
    expect(typedAddressCandidates("http://192.168.0.16")).toEqual([
      "http://192.168.0.16:8790",
      "http://192.168.0.16",
    ]);
  });

  test("trusts an address that already names a port", () => {
    expect(typedAddressCandidates("192.168.0.16:8096")).toEqual([
      "192.168.0.16:8096",
    ]);
  });

  test("trusts an address that carries a path", () => {
    expect(typedAddressCandidates("http://nas/jellyfin")).toEqual([
      "http://nas/jellyfin",
    ]);
  });

  test("leaves an IPv6 literal alone rather than guessing at it", () => {
    expect(typedAddressCandidates("http://[fd00::1]")).toEqual([
      "http://[fd00::1]",
    ]);
  });

  test("trims, drops a trailing slash, and says nothing about nothing", () => {
    expect(typedAddressCandidates("  192.168.0.16:8790/  ")).toEqual([
      "192.168.0.16:8790",
    ]);
    expect(typedAddressCandidates("   ")).toEqual([]);
  });
});
