import { describe, expect, test } from "bun:test";
import { normalizeHealthz } from "./healthzShape";

/**
 * `/healthz` answers two documents, and `children` is a different type in each.
 *
 * On the machine it is the list of children; to anybody else the gateway sends a redacted document
 * where `children` is a count (`gateway/mod.rs`, `public_health`). Four screens read it as the list
 * either way, so a node reached through a domain or a tunnel crashed on `children.find is not a
 * function`. These pin the shape, because the failure only ever appeared off-machine — which is
 * exactly where nobody was looking.
 */

describe("normalizeHealthz", () => {
  test("keeps the child list a node gives a caller on its own machine", () => {
    const doc = normalizeHealthz({
      status: "ok",
      children: [
        { name: "radarr", enabled: true, state: "healthy" },
        { name: "sonarr", enabled: false, state: "disabled" },
      ],
    });

    expect(doc.redacted).toBe(false);
    expect(doc.childCount).toBe(2);
    expect(doc.children.map((c) => c.name)).toEqual(["radarr", "sonarr"]);
  });

  test("turns the stranger's count into an empty list, not a crash", () => {
    // The whole bug: this used to arrive as `children: 5` and every `.find` on it threw.
    const doc = normalizeHealthz({ status: "ok", children: 5 });

    expect(doc.children).toEqual([]);
    expect(doc.redacted).toBe(true);
    expect(doc.childCount).toBe(5);
    expect(() => doc.children.find((c) => c.name === "radarr")).not.toThrow();
  });

  test("an empty list is a node running nothing, not a redacted one", () => {
    // The distinction the whole `redacted` flag exists for: `useArrReady` answers "off" for the
    // first and "unknown" for the second, and getting them the wrong way round is what told a
    // remote administrator downloading was not set up on a node that was downloading fine.
    const doc = normalizeHealthz({ status: "ok", children: [] });

    expect(doc.redacted).toBe(false);
    expect(doc.childCount).toBe(0);
  });

  test("a body with no children at all is treated as redacted rather than empty", () => {
    // A build too old to send the field, or a truncated body. Claiming it runs nothing would be a
    // guess; "would not say" is what we actually know.
    expect(normalizeHealthz({ status: "ok" }).redacted).toBe(true);
    expect(normalizeHealthz({}).childCount).toBe(0);
    expect(normalizeHealthz(null).children).toEqual([]);
  });

  test("everything else on the document survives", () => {
    const doc = normalizeHealthz({
      status: "degraded",
      node: { id: "n1", name: "Loft" },
      gateway: { port: 8801 },
      children: 3,
    });

    expect(doc.status).toBe("degraded");
    expect(doc.node.name).toBe("Loft");
    expect(doc.gateway.port).toBe(8801);
  });
});
