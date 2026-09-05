import { beforeEach, describe, expect, test } from "bun:test";
import {
  candidatesToTry,
  DEFAULT_TIMEOUT_MS,
  diagnoseRebinding,
  fetchDiscoveryRecord,
  forgetWinner,
  type Hello,
  nodeIdToZ32,
  type ProbeOutcome,
  pickWinner,
  plainLanFallback,
  probeCandidate,
  REBINDING_WARNING,
  raceSideDoor,
  recallWinner,
  rememberWinner,
  type SideDoorCandidate,
  type SideDoorRecord,
  sideDoorFromDiscovery,
  WINNER_TTL_MS,
  type WinnerStore,
  z32ToNodeId,
} from "./sidedoor";

const NODE = "yqbjqbjqbjqbjqbjqbjqbjqbjqbjqbjqbjqbjqbjqbjqbjqbjqby";
const ZONE = "direct.example.org";

function candidate(
  kind: "lan" | "pub" | "relay",
  port = 8790,
): SideDoorCandidate {
  const host = `${kind}.${NODE}.${ZONE}`;
  return { kind, host, port, url: `https://${host}:${port}` };
}

function record(overrides: Partial<SideDoorRecord> = {}): SideDoorRecord {
  return {
    node: NODE,
    zone: ZONE,
    candidates: [candidate("lan"), candidate("pub"), candidate("relay", 443)],
    lan_ips: ["192.168.1.5"],
    http_port: 8790,
    updated_at: "2026-09-05T00:00:00Z",
    ...overrides,
  };
}

/** A `fetch` that answers only the URLs it is told about, after the delay it is told about. */
function fakeFetch(
  routes: Record<
    string,
    { delay?: number; body?: Partial<Hello>; status?: number }
  >,
) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    calls.push(href);
    const origin = href.replace("/sidedoor/v1/hello", "");
    const route = routes[origin];
    if (!route) {
      // Not configured: hang until the caller's own timeout aborts, which is what an
      // unreachable host really does.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    }
    if (route.delay) {
      await new Promise((r) => setTimeout(r, route.delay));
    }
    const body: Hello = {
      ok: true,
      node: NODE,
      secure: origin.startsWith("https://"),
      client_ip: "203.0.113.9",
      ...route.body,
    };
    return new Response(JSON.stringify(body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** An in-memory `WinnerStore`, plus one that throws on every call. */
function memoryStore(): WinnerStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

const throwingStore: WinnerStore = {
  getItem() {
    throw new Error("site data is blocked");
  },
  setItem() {
    throw new Error("site data is blocked");
  },
  removeItem() {
    throw new Error("site data is blocked");
  },
};

describe("candidatesToTry", () => {
  test("starts with the LAN name and ends with the relay", () => {
    const kinds = candidatesToTry(record()).map((c) => c.kind);
    expect(kinds).toEqual(["lan", "pub", "relay"]);
  });

  test("drops the public name the coordinator already found unreachable", () => {
    // The coordinator tried a real TLS handshake from outside; that is a better test than
    // anything this side can run, and skipping it saves a full timeout.
    const kinds = candidatesToTry(record({ direct_https: "blocked" })).map(
      (c) => c.kind,
    );
    expect(kinds).toEqual(["lan", "relay"]);
  });

  test("keeps the public name while the verdict is unknown", () => {
    for (const v of ["unknown", "ok", undefined] as const) {
      const kinds = candidatesToTry(record({ direct_https: v })).map(
        (c) => c.kind,
      );
      expect(kinds).toContain("pub");
    }
  });

  test("a record with no candidates yields nothing rather than throwing", () => {
    expect(candidatesToTry(record({ candidates: [] }))).toEqual([]);
  });
});

describe("plainLanFallback", () => {
  test("builds the plain-HTTP URL from the published address and port", () => {
    expect(plainLanFallback(record())).toEqual({
      kind: "lan-ip-http",
      host: "192.168.1.5",
      port: 8790,
      url: "http://192.168.1.5:8790",
    });
  });

  test("brackets an IPv6 address, which a URL requires and the record does not carry", () => {
    const c = plainLanFallback(record({ lan_ips: ["fd00::5"] }));
    expect(c?.url).toBe("http://[fd00::5]:8790");
  });

  test("is null when the node published no address or no port", () => {
    expect(plainLanFallback(record({ lan_ips: [] }))).toBeNull();
    expect(plainLanFallback(record({ http_port: undefined }))).toBeNull();
  });
});

describe("diagnoseRebinding", () => {
  const outcome = (kind: "lan" | "lan-ip-http", ok: boolean): ProbeOutcome => ({
    candidate:
      kind === "lan"
        ? candidate("lan")
        : {
            kind,
            host: "192.168.1.5",
            port: 8790,
            url: "http://192.168.1.5:8790",
          },
    ok,
    ms: 5,
  });

  test("the signature is the name failing while the address answers", () => {
    const d = diagnoseRebinding([
      outcome("lan", false),
      outcome("lan-ip-http", true),
    ]);
    expect(d.rebinding).toBe(true);
  });

  test("both failing means this client is simply not on that network", () => {
    const d = diagnoseRebinding([
      outcome("lan", false),
      outcome("lan-ip-http", false),
    ]);
    expect(d.rebinding).toBe(false);
    expect(d.reason).toContain("not on the node's network");
  });

  test("the name working is not rebinding, however fast the address was", () => {
    const d = diagnoseRebinding([
      outcome("lan", true),
      outcome("lan-ip-http", true),
    ]);
    expect(d.rebinding).toBe(false);
  });

  test("not enough evidence is reported as such rather than guessed at", () => {
    expect(diagnoseRebinding([outcome("lan", false)]).rebinding).toBe(false);
    expect(diagnoseRebinding([]).reason).toContain("not enough");
  });
});

describe("pickWinner", () => {
  const mk = (
    kind: SideDoorCandidate["kind"],
    ms: number,
    ok = true,
  ): ProbeOutcome => ({
    candidate: { kind, host: "h", port: 1, url: `x://${kind}` },
    ok,
    ms,
  });

  test("the fastest encrypted candidate wins", () => {
    const w = pickWinner([mk("relay", 10), mk("lan", 2), mk("pub", 40)]);
    expect(w?.candidate.kind).toBe("lan");
  });

  test("an encrypted candidate beats a faster plain-HTTP one", () => {
    // The whole point: letting the fallback win on speed would quietly drop every user on a
    // fast LAN to an un-encrypted connection.
    const w = pickWinner([mk("lan-ip-http", 1), mk("relay", 90)]);
    expect(w?.candidate.kind).toBe("relay");
  });

  test("the plain fallback wins only when nothing else answered", () => {
    const w = pickWinner([mk("lan", 5, false), mk("lan-ip-http", 50)]);
    expect(w?.candidate.kind).toBe("lan-ip-http");
  });

  test("nothing answering is null, not a throw", () => {
    expect(pickWinner([mk("lan", 5, false)])).toBeNull();
    expect(pickWinner([])).toBeNull();
  });
});

describe("probeCandidate", () => {
  test("a reply from the expected node is a win", async () => {
    const { impl } = fakeFetch({ [candidate("lan").url]: {} });
    const out = await probeCandidate(candidate("lan"), NODE, {
      fetchImpl: impl,
    });
    expect(out.ok).toBe(true);
    expect(out.hello?.client_ip).toBe("203.0.113.9");
  });

  test("a reply from a different node is a failure, not a win", async () => {
    // A stale or hostile DNS answer that lands on somebody else's StingStream must not be
    // treated as having reached this one.
    const { impl } = fakeFetch({
      [candidate("lan").url]: { body: { node: "someothernode" } },
    });
    const out = await probeCandidate(candidate("lan"), NODE, {
      fetchImpl: impl,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("someothernode");
  });

  test("a non-200 is a failure carrying its status", async () => {
    const { impl } = fakeFetch({ [candidate("lan").url]: { status: 503 } });
    const out = await probeCandidate(candidate("lan"), NODE, {
      fetchImpl: impl,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("HTTP 503");
  });

  test("a host that never answers times out rather than hanging", async () => {
    const { impl } = fakeFetch({});
    const out = await probeCandidate(candidate("pub"), NODE, {
      fetchImpl: impl,
      timeoutMs: 20,
    });
    expect(out.ok).toBe(false);
  });

  test("it asks the CORS-safe endpoint and sends no credentials", async () => {
    let seen: RequestInit | undefined;
    const impl = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(
        JSON.stringify({ ok: true, node: NODE, secure: true }),
      );
    }) as unknown as typeof fetch;
    await probeCandidate(candidate("lan"), NODE, { fetchImpl: impl });
    expect(seen?.credentials).toBe("omit");
    expect(seen?.cache).toBe("no-store");
  });
});

describe("raceSideDoor", () => {
  let store: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    store = memoryStore();
  });

  test("keeps the first candidate that answers", async () => {
    const { impl } = fakeFetch({
      [candidate("lan").url]: { delay: 1 },
      [candidate("relay", 443).url]: { delay: 60 },
    });
    const choice = await raceSideDoor(record(), {
      fetchImpl: impl,
      store,
      timeoutMs: 300,
    });
    expect(choice?.kind).toBe("lan");
    expect(choice?.secure).toBe(true);
  });

  test("falls through to the relay when the direct names are unreachable", async () => {
    const { impl } = fakeFetch({ [candidate("relay", 443).url]: {} });
    const choice = await raceSideDoor(record(), {
      fetchImpl: impl,
      store,
      timeoutMs: 30,
    });
    expect(choice?.kind).toBe("relay");
  });

  test("never opens a public name the coordinator called blocked", async () => {
    const { impl, calls } = fakeFetch({ [candidate("relay", 443).url]: {} });
    await raceSideDoor(record({ direct_https: "blocked" }), {
      fetchImpl: impl,
      store,
      timeoutMs: 30,
    });
    expect(calls.some((c) => c.includes("pub."))).toBe(false);
  });

  test("a LAN name broken by DNS rebinding falls back to plain HTTP, with a warning", async () => {
    const { impl } = fakeFetch({
      // The name does not resolve; the address behind it answers.
      "http://192.168.1.5:8790": { body: { secure: false } },
    });
    const choice = await raceSideDoor(record(), {
      fetchImpl: impl,
      store,
      timeoutMs: 30,
    });
    expect(choice?.kind).toBe("lan-ip-http");
    expect(choice?.secure).toBe(false);
    expect(choice?.warning).toBe(REBINDING_WARNING);
  });

  test("nothing reachable at all is null, not a silent plain-HTTP win", async () => {
    const { impl } = fakeFetch({});
    const choice = await raceSideDoor(record(), {
      fetchImpl: impl,
      store,
      timeoutMs: 20,
    });
    expect(choice).toBeNull();
  });

  test("remembers the winner and tries it alone next time", async () => {
    const first = fakeFetch({
      [candidate("lan").url]: { delay: 1 },
      [candidate("relay", 443).url]: { delay: 40 },
    });
    await raceSideDoor(record(), {
      fetchImpl: first.impl,
      store,
      timeoutMs: 200,
    });

    const second = fakeFetch({ [candidate("lan").url]: {} });
    const choice = await raceSideDoor(record(), {
      fetchImpl: second.impl,
      store,
      timeoutMs: 200,
    });
    expect(choice?.kind).toBe("lan");
    // One request, not four: the whole point of remembering.
    expect(second.calls).toHaveLength(1);
  });

  test("a remembered winner that has stopped working re-races rather than failing", async () => {
    rememberWinner(
      NODE,
      { url: candidate("lan").url, kind: "lan", secure: true, ms: 1 },
      store,
    );
    const { impl, calls } = fakeFetch({ [candidate("relay", 443).url]: {} });
    const choice = await raceSideDoor(record(), {
      fetchImpl: impl,
      store,
      timeoutMs: 30,
    });
    expect(choice?.kind).toBe("relay");
    expect(calls.length).toBeGreaterThan(1);
  });

  test("a store that throws costs a race, not an error", async () => {
    const { impl } = fakeFetch({ [candidate("lan").url]: {} });
    const choice = await raceSideDoor(record(), {
      fetchImpl: impl,
      store: throwingStore,
      timeoutMs: 30,
    });
    expect(choice?.kind).toBe("lan");
  });

  test("a node that published nothing is null rather than a stray request", async () => {
    const { impl, calls } = fakeFetch({});
    const choice = await raceSideDoor(
      record({ candidates: [], lan_ips: [], http_port: undefined }),
      { fetchImpl: impl, store, timeoutMs: 20 },
    );
    expect(choice).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("the default timeout is short enough to be worth racing at all", () => {
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});

describe("remembering", () => {
  test("a winner is stored under the network it won on and as the last-known-good", () => {
    const store = memoryStore();
    rememberWinner(
      NODE,
      {
        url: candidate("pub").url,
        kind: "pub",
        secure: true,
        clientIp: "203.0.113.9",
        ms: 12,
      },
      store,
    );
    expect(store.map.size).toBe(2);
    expect(recallWinner(NODE, store)?.kind).toBe("pub");
    expect(
      recallWinner(NODE, store, () => Date.now(), "203.0.113.9")?.kind,
    ).toBe("pub");
  });

  test("an entry older than the TTL is discarded rather than trusted", () => {
    const store = memoryStore();
    let now = 1_000_000;
    rememberWinner(
      NODE,
      { url: candidate("lan").url, kind: "lan", secure: true, ms: 1 },
      store,
      () => now,
    );
    expect(recallWinner(NODE, store, () => now)).not.toBeNull();
    now += WINNER_TTL_MS + 1;
    expect(recallWinner(NODE, store, () => now)).toBeNull();
    // And it is cleaned up rather than left to be re-read every load.
    expect(store.map.size).toBe(0);
  });

  test("corrupt stored JSON is ignored, not thrown", () => {
    const store = memoryStore();
    store.map.set(`stingstream.sidedoor.winner.${NODE}.last`, "{not json");
    expect(recallWinner(NODE, store)).toBeNull();
  });

  test("forgetting removes both entries", () => {
    const store = memoryStore();
    rememberWinner(
      NODE,
      {
        url: candidate("lan").url,
        kind: "lan",
        secure: true,
        clientIp: "10.0.0.2",
        ms: 1,
      },
      store,
    );
    forgetWinner(NODE, store, "10.0.0.2");
    expect(store.map.size).toBe(0);
  });

  test("a store that throws never propagates", () => {
    expect(() =>
      rememberWinner(
        NODE,
        { url: "x", kind: "lan", secure: true, ms: 1 },
        throwingStore,
      ),
    ).not.toThrow();
    expect(recallWinner(NODE, throwingStore)).toBeNull();
    expect(() => forgetWinner(NODE, throwingStore)).not.toThrow();
  });

  test("no store at all is simply no memory", () => {
    expect(recallWinner(NODE, null)).toBeNull();
    expect(() =>
      rememberWinner(
        NODE,
        { url: "x", kind: "lan", secure: true, ms: 1 },
        null,
      ),
    ).not.toThrow();
  });
});

describe("node ids", () => {
  test("32 bytes become a 52-character label that fits in DNS", () => {
    const hex = "00".repeat(32);
    const z = nodeIdToZ32(hex);
    expect(z).toHaveLength(52);
    // 63 is the DNS limit, and the 64-character hex form is why this conversion exists at all.
    expect(z!.length).toBeLessThan(64);
    expect(z).toBe("y".repeat(52));
  });

  test("it agrees with iroh on a real node id", () => {
    // Taken from a live node in `tools/e2e-sidedoor.ps1`: the hex is what the mesh reports at
    // /mesh/v1/status, the z-base-32 is the label iroh put in the certificate it went on to get.
    // This is the load-bearing case -- an encoder that is merely self-consistent would build
    // hostnames for a node that does not exist, and every candidate would fail to resolve.
    const hex =
      "78a02697a3bdb3235b358b000eddf8794c4f9ded15b672163759a1aeed775a24";
    const z32 = "xnonpf7dzs31gs3itcyy7zxaxfgr98xpns58rftzmgo475mzme1y";
    expect(nodeIdToZ32(hex)).toBe(z32);
    expect(z32ToNodeId(z32)).toBe(hex);
  });

  test("the encoding round-trips", () => {
    const hex =
      "0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210";
    const z = nodeIdToZ32(hex);
    expect(z).not.toBeNull();
    expect(z32ToNodeId(z!)).toBe(hex);
  });

  test("it uses the z-base-32 alphabet, which excludes look-alike characters", () => {
    const z = nodeIdToZ32("ff".repeat(32))!;
    for (const forbidden of ["l", "v", "2", "0"]) {
      expect(z).not.toContain(forbidden);
    }
  });

  test("junk is null rather than a plausible-looking wrong answer", () => {
    expect(nodeIdToZ32("not hex")).toBeNull();
    expect(nodeIdToZ32("abc")).toBeNull();
    expect(z32ToNodeId("l")).toBeNull();
  });
});

describe("sideDoorFromDiscovery", () => {
  const discovery = {
    node: NODE,
    names: {
      lan: `lan.${NODE}.${ZONE}`,
      public: `pub.${NODE}.${ZONE}`,
      relay: `relay.${NODE}.${ZONE}`,
      wildcard: `*.${NODE}.${ZONE}`,
      acme_challenge: `_acme-challenge.${NODE}.${ZONE}`,
    },
    direct_https: "ok" as const,
  };

  test("turns the coordinator's public record into something raceable", () => {
    const r = sideDoorFromDiscovery(discovery)!;
    expect(r.candidates.map((c) => c.kind)).toEqual(["lan", "pub", "relay"]);
    expect(r.candidates[2].port).toBe(443);
    expect(r.candidates[0].url).toBe(`https://lan.${NODE}.${ZONE}:8790`);
    expect(r.direct_https).toBe("ok");
  });

  test("the ports are supplied, because the coordinator does not know them", () => {
    const r = sideDoorFromDiscovery(discovery, {
      httpsPort: 443,
      relayPort: 8443,
    })!;
    expect(r.candidates[0].port).toBe(443);
    expect(r.candidates[2].port).toBe(8443);
  });

  test("a record with no names is null", () => {
    expect(sideDoorFromDiscovery({ node: NODE })).toBeNull();
  });
});

describe("fetchDiscoveryRecord", () => {
  test("reads the coordinator's record for one node", async () => {
    let seen = "";
    const impl = (async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ node: NODE, direct_https: "ok" }));
    }) as unknown as typeof fetch;
    const r = await fetchDiscoveryRecord("https://coord.example.org/", NODE, {
      fetchImpl: impl,
    });
    expect(seen).toBe(`https://coord.example.org/node/v1/${NODE}`);
    expect(r?.direct_https).toBe("ok");
  });

  test("a coordinator that has never seen the node is null, not a throw", async () => {
    const impl = (async () =>
      new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(
      await fetchDiscoveryRecord("https://coord.example.org", NODE, {
        fetchImpl: impl,
      }),
    ).toBeNull();
  });

  test("an unreachable coordinator is null, not a throw", async () => {
    const impl = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(
      await fetchDiscoveryRecord("https://coord.example.org", NODE, {
        fetchImpl: impl,
      }),
    ).toBeNull();
  });
});
