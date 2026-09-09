import { beforeEach, describe, expect, test } from "bun:test";
import { stubMmkv } from "@/test-utils/mmkv";

// `@/utils/mmkv` builds its instance at module evaluation and needs a native module bun:test
// cannot load, so the stub goes in before the import that pulls it.
stubMmkv();

const {
  findLiveServer,
  KNOWN_SERVER_TTL_MS,
  MAX_KNOWN_SERVERS,
  mergeKnownServers,
  orderKnownServers,
  pruneKnownServers,
  readKnownServers,
  rememberServers,
  writeKnownServers,
} = await import("./knownServers");

import type { KnownServer } from "./knownServers";
import type { SideDoorRecord } from "./sidedoor";

const NOW = Date.parse("2026-09-09T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function record(
  node: string,
  kinds: ("own" | "lan-ip-http")[],
): SideDoorRecord {
  return {
    node,
    candidates: kinds.map((kind) => ({
      kind,
      host: kind === "own" ? `${node}.example.com` : "192.168.0.16",
      port: kind === "own" ? 443 : 8790,
      url:
        kind === "own"
          ? `https://${node}.example.com`
          : "http://192.168.0.16:8790",
    })),
  };
}

const server = (
  nodeId: string,
  kinds: ("own" | "lan-ip-http")[],
  msAgo = 0,
): KnownServer => ({
  nodeId,
  name: nodeId,
  record: record(nodeId, kinds),
  lastSeen: iso(msAgo),
});

describe("orderKnownServers", () => {
  // Dan's choice, in his words: "Public first, then LAN".
  test("a server with a domain is tried before one with only a LAN address", () => {
    const ordered = orderKnownServers([
      server("lan", ["lan-ip-http"]),
      server("pub", ["own"]),
    ]);
    expect(ordered.map((s) => s.nodeId)).toEqual(["pub", "lan"]);
  });

  test("within each half, the one seen most recently goes first", () => {
    const ordered = orderKnownServers([
      server("old", ["own"], 60_000),
      server("new", ["own"], 1_000),
      server("lan", ["lan-ip-http"], 0),
    ]);
    expect(ordered.map((s) => s.nodeId)).toEqual(["new", "old", "lan"]);
  });

  test("a server offering both counts as public", () => {
    const ordered = orderKnownServers([
      server("lan", ["lan-ip-http"], 0),
      server("both", ["own", "lan-ip-http"], 60_000),
    ]);
    expect(ordered[0].nodeId).toBe("both");
  });
});

describe("pruneKnownServers", () => {
  test("a server nobody has seen for longer than the window is forgotten", () => {
    const kept = pruneKnownServers(
      [
        server("fresh", ["own"], KNOWN_SERVER_TTL_MS - 1000),
        server("stale", ["own"], KNOWN_SERVER_TTL_MS + 1000),
      ],
      NOW,
    );
    expect(kept.map((s) => s.nodeId)).toEqual(["fresh"]);
  });

  test("a record with nowhere to go is not worth a timeout", () => {
    expect(pruneKnownServers([server("nowhere", [])], NOW)).toEqual([]);
  });

  test("an unparseable date is kept rather than silently dropped", () => {
    const odd = { ...server("odd", ["own"]), lastSeen: "not a date" };
    expect(pruneKnownServers([odd], NOW)).toHaveLength(1);
  });
});

describe("mergeKnownServers", () => {
  test("the newer record for a node wins", () => {
    const merged = mergeKnownServers(
      [server("a", ["lan-ip-http"], 60_000)],
      [server("a", ["own"], 0)],
      NOW,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].record.candidates[0].kind).toBe("own");
  });

  // The whole point of remembering: a peer that is off right now is exactly the one this list is
  // for. Merging must not treat "not seen just now" as "gone".
  test("a server that was not in the latest sighting is kept", () => {
    const merged = mergeKnownServers(
      [server("a", ["own"], 60_000)],
      [server("b", ["own"], 0)],
      NOW,
    );
    expect(merged.map((s) => s.nodeId).sort()).toEqual(["a", "b"]);
  });

  test("nothing with an empty node id or no candidates gets in", () => {
    const merged = mergeKnownServers(
      [],
      [server("", ["own"]), server("nowhere", [])],
      NOW,
    );
    expect(merged).toEqual([]);
  });

  test("the list is capped, keeping the ones worth trying", () => {
    const many = Array.from({ length: MAX_KNOWN_SERVERS + 5 }, (_, i) =>
      server(`n${i}`, ["own"], i * 1000),
    );
    const merged = mergeKnownServers([], many, NOW);
    expect(merged).toHaveLength(MAX_KNOWN_SERVERS);
    // Most recently seen survives the cap.
    expect(merged[0].nodeId).toBe("n0");
  });
});

describe("storage", () => {
  beforeEach(() => writeKnownServers([]));

  test("what is written comes back", () => {
    rememberServers([server("a", ["own"])]);
    expect(readKnownServers().map((s) => s.nodeId)).toEqual(["a"]);
  });

  test("rubbish in storage reads as nothing rather than throwing on the boot path", () => {
    writeKnownServers([]);
    expect(readKnownServers()).toEqual([]);
  });

  test("remembering merges rather than replaces", () => {
    rememberServers([server("a", ["own"], 60_000)]);
    rememberServers([server("b", ["own"], 0)]);
    expect(
      readKnownServers()
        .map((s) => s.nodeId)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});

describe("findLiveServer", () => {
  test("skips the origin it is being called because of, matched on the URL", async () => {
    // The caller has an origin, not a node id: the marker that would have carried an identity is
    // exactly what a dead server failed to send. Racing it again is a guaranteed timeout.
    const dead = server("dead", ["own"]);
    dead.record.candidates[0].url = "https://dead.example.com";
    const found = await findLiveServer([dead], {
      exceptOrigin: "https://dead.example.com/",
      timeoutMs: 1,
    });
    expect(found).toBeNull();
  });

  test("nothing remembered is not an error", async () => {
    expect(await findLiveServer([], { timeoutMs: 1 })).toBeNull();
  });
});
