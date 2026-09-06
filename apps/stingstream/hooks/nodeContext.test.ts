import { describe, expect, test } from "bun:test";
import { jellyfinUrlFor, parseNodeMarker } from "./useNodeContext";

/** What the gateway actually splices in, field for field (gateway/web.rs `MarkerJson`). */
const marker = (overrides: Record<string, unknown> = {}) => ({
  node: true,
  jellyfin: "/jellyfin",
  api: "/stingstream/api/v1",
  loopback: true,
  setupPending: true,
  nodeName: "attic",
  version: "0.2.0",
  ...overrides,
});

const ORIGIN = "http://localhost:8790";

describe("parseNodeMarker", () => {
  test("a well-formed marker becomes the node context", () => {
    const context = parseNodeMarker({ marker: marker(), origin: ORIGIN });

    expect(context).toEqual({
      origin: ORIGIN,
      jellyfinPath: "/jellyfin",
      apiPath: "/stingstream/api/v1",
      loopback: true,
      setupPending: true,
      nodeName: "attic",
      version: "0.2.0",
    });
  });

  test("the origin is the page's, not the marker's — a node names no address", () => {
    const context = parseNodeMarker({
      marker: marker(),
      origin: "http://192.168.0.16:8790/",
    });

    // Trailing slash trimmed so the paths below concatenate cleanly.
    expect(context?.origin).toBe("http://192.168.0.16:8790");
    expect(jellyfinUrlFor(context!)).toBe("http://192.168.0.16:8790/jellyfin");
  });

  test("setupPending: null is a real answer and survives as null", () => {
    expect(
      parseNodeMarker({
        marker: marker({ setupPending: null }),
        origin: ORIGIN,
      })?.setupPending,
    ).toBeNull();
    expect(
      parseNodeMarker({
        marker: marker({ setupPending: false }),
        origin: ORIGIN,
      })?.setupPending,
    ).toBe(false);
  });

  test("loopback is only true when the marker says exactly true", () => {
    expect(
      parseNodeMarker({ marker: marker({ loopback: "yes" }), origin: ORIGIN })
        ?.loopback,
    ).toBe(false);
  });

  describe("malformed markers", () => {
    test("unusable paths fall back to the documented defaults", () => {
      const context = parseNodeMarker({
        marker: marker({ jellyfin: "jellyfin", api: 42 }),
        origin: ORIGIN,
      });

      expect(context?.jellyfinPath).toBe("/jellyfin");
      expect(context?.apiPath).toBe("/stingstream/api/v1");
    });

    test("empty node name and version read as absent, not as empty strings", () => {
      const context = parseNodeMarker({
        marker: marker({ nodeName: "   ", version: "" }),
        origin: ORIGIN,
      });

      expect(context?.nodeName).toBeNull();
      expect(context?.version).toBeNull();
    });

    test("a broken payload with the meta tag still counts as a node", () => {
      // The tag is the presence signal; sending someone back to typing an address at the very
      // machine the node runs on because a JSON field changed shape would be the worse failure.
      const context = parseNodeMarker({
        marker: "not an object",
        origin: ORIGIN,
        meta: true,
      });

      expect(context).toEqual({
        origin: ORIGIN,
        jellyfinPath: "/jellyfin",
        apiPath: "/stingstream/api/v1",
        loopback: false,
        setupPending: null,
        nodeName: null,
        version: null,
      });
    });

    test("a broken payload with no meta tag is not a node", () => {
      expect(
        parseNodeMarker({ marker: { node: false }, origin: ORIGIN }),
      ).toBeNull();
      expect(parseNodeMarker({ marker: [1, 2], origin: ORIGIN })).toBeNull();
      expect(parseNodeMarker({ marker: null, origin: ORIGIN })).toBeNull();
    });
  });

  test("absent: a plain static server serving the same bundle is not a node", () => {
    expect(parseNodeMarker({ origin: "https://example.org" })).toBeNull();
    expect(parseNodeMarker(null)).toBeNull();
    expect(parseNodeMarker(undefined)).toBeNull();
  });

  describe("env fallback", () => {
    test("native — no document at all — uses the env URL when there is one", () => {
      const context = parseNodeMarker(null, "http://10.0.2.2:8790");

      expect(context).toEqual({
        origin: "http://10.0.2.2:8790",
        jellyfinPath: "/jellyfin",
        apiPath: "/stingstream/api/v1",
        // Neither is knowable from an env var; `setup/state` answers both per request.
        loopback: false,
        setupPending: null,
        nodeName: null,
        version: null,
      });
    });

    test("native with no env URL is null — the phone keeps the address step", () => {
      expect(parseNodeMarker(null, null)).toBeNull();
      expect(parseNodeMarker(null, "")).toBeNull();
    });

    test("a real marker beats a stale env URL baked into the bundle", () => {
      const context = parseNodeMarker(
        { marker: marker(), origin: ORIGIN },
        "http://10.0.2.2:8790",
      );

      expect(context?.origin).toBe(ORIGIN);
    });

    test("an env value that is not an absolute http(s) origin is refused", () => {
      // Connecting to the wrong thing silently is worse than showing the address form.
      expect(parseNodeMarker(null, "10.0.2.2:8790")).toBeNull();
      expect(parseNodeMarker(null, "/jellyfin")).toBeNull();
      expect(parseNodeMarker(null, "file:///tmp/index.html")).toBeNull();
    });

    test("a trailing slash on the env URL is trimmed", () => {
      expect(parseNodeMarker(null, "http://10.0.2.2:8790/")?.origin).toBe(
        "http://10.0.2.2:8790",
      );
    });
  });
});
