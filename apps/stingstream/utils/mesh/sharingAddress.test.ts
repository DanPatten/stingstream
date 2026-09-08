import { describe, expect, test } from "bun:test";
import {
  isBlank,
  isUntouched,
  sharingAddress,
  sharingAddressProblem,
  sharingAddressReady,
  sharingAddressUrl,
} from "./sharingAddress";

/**
 * These four rules are the node's (`stingstream_mesh::sharing::normalize_public_address`), checked
 * here too so somebody is told at the keyboard rather than after pressing Save. Each rejection is
 * a value that produces a link which *looks* right and does not work, which is exactly the kind of
 * mistake no screenshot catches.
 */
describe("sharingAddressProblem", () => {
  test("a domain is fine, with or without a scheme", () => {
    expect(
      sharingAddressProblem(sharingAddress("https://media.example.com")),
    ).toBeNull();
    expect(
      sharingAddressProblem(sharingAddress("media.example.com")),
    ).toBeNull();
    expect(
      sharingAddressProblem(sharingAddress("media.example.com:8443")),
    ).toBeNull();
  });

  // A residential address rotates, no certificate authority will issue for one, and behind
  // carrier-grade NAT there is no inbound address at all. It is the first thing people try.
  test("a bare IP address is refused, v4 and v6", () => {
    expect(sharingAddressProblem(sharingAddress("203.0.113.9"))).toBe(
      "ip-address",
    );
    expect(
      sharingAddressProblem(sharingAddress("https://203.0.113.9:8790")),
    ).toBe("ip-address");
    expect(sharingAddressProblem(sharingAddress("https://[2001:db8::1]"))).toBe(
      "ip-address",
    );
  });

  // The thing this opens is a browser app; outside a secure context `crypto.randomUUID` and secure
  // storage are simply absent. This fork already hit that crash once, on LAN origins.
  test("plain http is refused", () => {
    expect(
      sharingAddressProblem(sharingAddress("http://media.example.com")),
    ).toBe("insecure");
  });

  test("a single-label host is refused, because only you can resolve it", () => {
    expect(sharingAddressProblem(sharingAddress("nas"))).toBe("single-label");
  });

  test("blank is not a problem — clearing the address is an ordinary thing to do", () => {
    expect(sharingAddressProblem(sharingAddress(""))).toBeNull();
    expect(sharingAddressProblem(sharingAddress("   "))).toBeNull();
    expect(sharingAddressReady(sharingAddress(""))).toBe(true);
    expect(isBlank(sharingAddress("  "))).toBe(true);
  });
});

describe("sharingAddressUrl", () => {
  test("stores an origin, so appending /join never doubles a slash", () => {
    expect(
      sharingAddressUrl(sharingAddress("https://media.example.com/")),
    ).toBe("https://media.example.com");
    expect(sharingAddressUrl(sharingAddress("media.example.com"))).toBe(
      "https://media.example.com",
    );
    expect(sharingAddressUrl(sharingAddress("media.example.com:8443"))).toBe(
      "https://media.example.com:8443",
    );
  });

  test("nothing usable stores null rather than something half-parsed", () => {
    expect(sharingAddressUrl(sharingAddress(""))).toBeNull();
    expect(sharingAddressUrl(sharingAddress("203.0.113.9"))).toBeNull();
    expect(
      sharingAddressUrl(sharingAddress("http://media.example.com")),
    ).toBeNull();
  });
});

/**
 * The failure this guards is specific and was live once: an admin editing a domain that only
 * resolves at home, from mobile data, found Save disabled by a value they had never typed — and
 * worse, a save that wrote `null` over an address that was fine.
 */
describe("isUntouched", () => {
  test("a value straight from the node is left alone", () => {
    expect(
      isUntouched(
        sharingAddress("https://media.example.com"),
        "https://media.example.com",
      ),
    ).toBe(true);
    expect(
      isUntouched(
        sharingAddress(" https://media.example.com "),
        "https://media.example.com",
      ),
    ).toBe(true);
    expect(isUntouched(sharingAddress(""), null)).toBe(true);
  });

  test("anything actually typed is not", () => {
    expect(
      isUntouched(
        sharingAddress("https://other.example.com"),
        "https://media.example.com",
      ),
    ).toBe(false);
    expect(isUntouched(sharingAddress("x"), null)).toBe(false);
  });
});
