import { describe, expect, test } from "bun:test";
import type {
  MeshDomainsStatus,
  MeshTunnelStatus,
} from "@/lib/stingstream/meshApi";
import { bareHostname, domainsSummary, hasTunnel } from "./domainsStatus";

const tunnel = (over: Partial<MeshTunnelStatus> = {}): MeshTunnelStatus => ({
  kind: "none",
  state: "off",
  hostname: null,
  detail: null,
  binaryPresent: true,
  ...over,
});

const LAN = "http://192.168.0.16:8797";

const status = (over: Partial<MeshDomainsStatus> = {}): MeshDomainsStatus => ({
  publicAddress: null,
  https: "off",
  certificate: null,
  publicIp: null,
  lanUrls: [LAN],
  tunnel: tunnel(),
  ...over,
});

/**
 * Either LAN or public, and the address is the answer rather than a label about it.
 *
 * The ordering is the only real logic here, and several of these are simultaneously true on a real
 * server.
 */
describe("domainsSummary", () => {
  test("a server with no domain is on its own network, and says which address that is", () => {
    // The bug this replaced: the page said "No address yet" over a server that plainly had one.
    // There is no such thing as no address.
    expect(domainsSummary(status())).toEqual({
      reach: "lan",
      address: LAN,
      detail: null,
    });
  });

  test("a domain makes it public, and that address wins over the LAN one", () => {
    expect(
      domainsSummary(status({ publicAddress: "https://media.example.com" })),
    ).toEqual({
      reach: "public",
      address: "https://media.example.com",
      detail: null,
    });
  });

  test("a certificate does not change the answer, only how it got there", () => {
    // `https: ready` used to be a headline of its own. It is not a different kind of reach: the
    // address is public either way, and which end terminates TLS is not what the reader is asking.
    expect(
      domainsSummary(
        status({
          publicAddress: "https://media.example.com",
          https: "ready",
          certificate: { names: ["media.example.com"], expires: null },
        }),
      ).reach,
    ).toBe("public");
  });

  test("an address with no TLS on the node is still public, not broken", () => {
    // Exactly what a working reverse proxy looks like from in here. This server cannot see the
    // other end of its own domain, so it reports rather than judges.
    expect(
      domainsSummary(
        status({
          publicAddress: "https://media.example.com",
          https: "no_certificate",
        }),
      ).reach,
    ).toBe("public");
  });

  test("a tunnel coming up says so, and names the address it is coming up on", () => {
    expect(
      domainsSummary(
        status({
          tunnel: tunnel({
            kind: "named",
            state: "starting",
            hostname: "media.example.com",
          }),
        }),
      ),
    ).toEqual({
      reach: "starting",
      address: "media.example.com",
      detail: null,
    });
  });

  test("a broken tunnel outranks a perfectly good certificate", () => {
    // Both true at once. The broken one is what somebody just pressed a button to create, and the
    // calm fact would bury it.
    expect(
      domainsSummary(
        status({
          publicAddress: "https://media.example.com",
          https: "ready",
          certificate: { names: ["media.example.com"], expires: null },
          tunnel: tunnel({
            kind: "named",
            state: "error",
            hostname: "media.example.com",
            detail: "Invalid access token (9109)",
          }),
        }),
      ),
    ).toEqual({
      reach: "error",
      address: "media.example.com",
      detail: "Invalid access token (9109)",
    });
  });

  test("no answer yet is the LAN case with nothing to show, not an error", () => {
    // The first render, before the query returns. An error there would flash a problem at somebody
    // who does not have one.
    expect(domainsSummary(undefined)).toEqual({
      reach: "lan",
      address: null,
      detail: null,
    });
    expect(domainsSummary(status({ lanUrls: [] })).address).toBeNull();
  });
});

describe("hasTunnel", () => {
  test("only a configured tunnel counts", () => {
    expect(hasTunnel(status())).toBe(false);
    expect(hasTunnel(undefined)).toBe(false);
    // Configured but down is still configured: the thing to offer is "stop it", not "set one up".
    expect(
      hasTunnel(status({ tunnel: tunnel({ kind: "named", state: "error" }) })),
    ).toBe(true);
  });
});

describe("bareHostname", () => {
  test("takes a hostname out of anything somebody might paste", () => {
    expect(bareHostname("media.example.com")).toBe("media.example.com");
    expect(bareHostname("https://media.example.com")).toBe("media.example.com");
    expect(bareHostname("https://media.example.com/")).toBe(
      "media.example.com",
    );
    expect(bareHostname("  https://media.example.com/join  ")).toBe(
      "media.example.com",
    );
    expect(bareHostname("http://media.example.com:8790")).toBe(
      "media.example.com",
    );
  });

  test("gives back what it was handed when that is not a URL at all", () => {
    // Half-typed input, on its way to the field's own validator. Throwing here would blank the
    // hostname box on a keystroke.
    expect(bareHostname("media example")).toBe("media example");
    expect(bareHostname("")).toBe("");
  });
});
