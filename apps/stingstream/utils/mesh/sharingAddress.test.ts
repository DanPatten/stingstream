import { describe, expect, test } from "bun:test";
import type { CoordinatorCheck } from "./coordinator";
import {
  DEFAULT_SHARING_SERVER,
  isUntouched,
  sharingAddress,
  sharingAddressReady,
  sharingAddressUrl,
} from "./sharingAddress";

const withCheck = (input: string, check: CoordinatorCheck) => ({
  input,
  check,
});

const coordinator = (url: string): CoordinatorCheck => ({
  state: "ok",
  url,
  health: {
    ok: true,
    mode: "lite",
    version: "0.1.0",
    uptime_secs: 1,
    relay: true,
    quic_address_discovery: false,
    rendezvous: true,
    sni_router: false,
    dns_zone: null,
    dns_provider: "none",
  },
});

const node = (url: string): CoordinatorCheck => ({
  state: "own-server",
  url,
  name: "attic",
});

const unreachable = (url: string): CoordinatorCheck => ({
  state: "unreachable",
  url,
  message: `Could not reach ${url}.`,
});

describe("each field takes one kind of address", () => {
  test("a coordinator is right for the sharing server and wrong for your own", () => {
    const value = withCheck(
      "coord.example.org",
      coordinator("https://coord.example.org"),
    );
    expect(sharingAddressReady(value, "coordinator")).toBe(true);
    expect(sharingAddressUrl(value, "coordinator")).toBe(
      "https://coord.example.org",
    );
    expect(sharingAddressReady(value, "own-server")).toBe(false);
    expect(sharingAddressUrl(value, "own-server")).toBeNull();
  });

  test("a node is right for your own address and wrong for the sharing server", () => {
    const value = withCheck(
      "media.example.com",
      node("https://media.example.com"),
    );
    expect(sharingAddressReady(value, "own-server")).toBe(true);
    expect(sharingAddressUrl(value, "own-server")).toBe(
      "https://media.example.com",
    );
    expect(sharingAddressReady(value, "coordinator")).toBe(false);
    expect(sharingAddressUrl(value, "coordinator")).toBeNull();
  });

  test("blank is ready for either, and stores nothing", () => {
    for (const accept of ["coordinator", "own-server"] as const) {
      expect(sharingAddressReady(sharingAddress(""), accept)).toBe(true);
      expect(sharingAddressUrl(sharingAddress("   "), accept)).toBeNull();
    }
  });

  test("a typed address that answered wrong blocks the save", () => {
    const value = withCheck(
      "typo.example.org",
      unreachable("https://typo.example.org"),
    );
    expect(sharingAddressReady(value, "coordinator")).toBe(false);
    expect(sharingAddressUrl(value, "coordinator")).toBeNull();
  });
});

/**
 * The address we ship is not something anybody typed, so there is no typo for the check to catch —
 * and the check itself is the part most likely to fail for reasons that are nobody's fault: a
 * coordinator having a moment, or one built before `/healthz` carried a CORS header, whose answer
 * the browser discards before the app ever sees it. Blocking on that would make a fresh install
 * unable to keep the setting it was shipped with.
 */
describe("the shipped address is trusted when its check cannot complete", () => {
  test("unreachable is still ready, and still stores the address", () => {
    const value = withCheck(
      DEFAULT_SHARING_SERVER,
      unreachable(DEFAULT_SHARING_SERVER),
    );
    expect(sharingAddressReady(value, "coordinator")).toBe(true);
    expect(sharingAddressUrl(value, "coordinator")).toBe(
      DEFAULT_SHARING_SERVER,
    );
  });

  test("but not when it turns out to be a node, which is a real contradiction", () => {
    const value = withCheck(
      DEFAULT_SHARING_SERVER,
      node(DEFAULT_SHARING_SERVER),
    );
    expect(sharingAddressUrl(value, "coordinator")).toBeNull();
  });

  test("and the leniency does not extend to anything else", () => {
    const value = withCheck(
      "coord.example.org",
      unreachable("https://coord.example.org"),
    );
    expect(sharingAddressReady(value, "coordinator")).toBe(false);
  });
});

/**
 * The check runs from whichever browser the admin is sitting in front of, which is not necessarily
 * where the address resolves. Without this, editing one field on mobile data would mark the *other*
 * one wrong and then save `null` over an address that was perfectly fine.
 */
describe("a value the node already stored is left alone", () => {
  test("untouched matches what was stored, trimmed", () => {
    expect(
      isUntouched(
        sharingAddress("https://media.example.com"),
        "https://media.example.com",
      ),
    ).toBe(true);
    expect(
      isUntouched(
        sharingAddress("  https://media.example.com  "),
        "https://media.example.com",
      ),
    ).toBe(true);
    expect(isUntouched(sharingAddress(""), null)).toBe(true);
    expect(isUntouched(sharingAddress(""), undefined)).toBe(true);
  });

  test("and an edit is no longer untouched", () => {
    expect(
      isUntouched(
        sharingAddress("https://other.example.com"),
        "https://media.example.com",
      ),
    ).toBe(false);
    expect(isUntouched(sharingAddress("media.example.com"), null)).toBe(false);
  });
});
