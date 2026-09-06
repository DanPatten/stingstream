import { describe, expect, test } from "bun:test";
import {
  parseFederatedStreamPath,
  resolveCastStreamUrl,
} from "./castStreamUrl";
import { nodeIdToZ32 } from "./sidedoor";

// castStreamUrl.ts deliberately imports the mesh's plain-fetch layer from `./meshApi`, not the
// React Query hooks in `./mesh` — the latter reaches `providers/JellyfinProvider` at module
// scope, whose import graph bun:test cannot load at all (a native `codegenNativeComponent` a few
// layers down). No react-native stub is needed here for exactly that reason.
type CastStreamResolution = NonNullable<
  Awaited<ReturnType<typeof resolveCastStreamUrl>>
>;

const GROUP = "g1";
const ITEM_KEY = "movie:tmdb:1";
const HOME_NODE = "home0000homenodehex";
const PEER_NODE = "peer0000peernodehex";
/** The signature and expiry a node puts on the URL it hands a client (M8b). */
const SIG = "?exp=1788652800&sig=79390d70a3e0d063d4e0850e57977759";

const suffix = (node: string, search = "") =>
  `/stream/${encodeURIComponent(GROUP)}/${encodeURIComponent(ITEM_KEY)}/${encodeURIComponent(node)}${search}`;

/** A `fetch` that answers only the URLs it is told about; anything else rejects. */
function fakeFetch(
  routes: Record<string, { status?: number; body?: unknown }>,
) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url.toString();
    calls.push(href);
    const route = routes[href];
    if (!route) return Promise.reject(new Error(`unexpected fetch: ${href}`));
    return new Response(
      route.body === undefined ? "" : JSON.stringify(route.body),
      { status: route.status ?? 200 },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const PEERS_URL = `https://jellyfin.example.com/stingstream/api/v1/mesh/peers?group=${GROUP}`;
const GROUPS_URL =
  "https://jellyfin.example.com/stingstream/api/v1/mesh/groups";
const STATUS_URL =
  "https://jellyfin.example.com/stingstream/api/v1/mesh/status";

describe("parseFederatedStreamPath", () => {
  test("reads group/item_key/node out of the raw stingstream.local form", () => {
    expect(
      parseFederatedStreamPath(
        `https://stingstream.local/stream/${GROUP}/${ITEM_KEY}/${PEER_NODE}`,
      ),
    ).toEqual({
      group: GROUP,
      itemKey: ITEM_KEY,
      node: PEER_NODE,
      search: "",
    });
  });

  test("reads it out of the loopback-rewritten form too — only the path matters", () => {
    expect(
      parseFederatedStreamPath(
        `http://127.0.0.1:41405/stream/${GROUP}/${ITEM_KEY}/${PEER_NODE}?x=1`,
      ),
    ).toEqual({
      group: GROUP,
      itemKey: ITEM_KEY,
      node: PEER_NODE,
      search: "?x=1",
    });
  });

  test("keeps the signature, because the receiver is refused without it", () => {
    // M8b: the node signs the stream URL it hands a client, and its gateway refuses an unsigned one
    // from anywhere but the machine it runs on. A cast receiver is somebody else's television.
    expect(
      parseFederatedStreamPath(
        `https://stingstream.local/stream/${GROUP}/${ITEM_KEY}/${PEER_NODE}${SIG}`,
      ),
    ).toEqual({
      group: GROUP,
      itemKey: ITEM_KEY,
      node: PEER_NODE,
      search: SIG,
    });
  });

  test("null for an ordinary (non-federated) path", () => {
    expect(
      parseFederatedStreamPath(
        "https://jellyfin.example.com/Videos/item-1/stream?static=true",
      ),
    ).toBeNull();
  });

  test("null for garbage", () => {
    expect(parseFederatedStreamPath("not a url at all")).toBeNull();
  });
});

describe("resolveCastStreamUrl", () => {
  test("carries the signature onto the URL the receiver is handed", async () => {
    // The one that matters. A cast receiver holds no credential of ours and never will, which is
    // why `/stream/*` takes a signed URL rather than a token — and this function is the only place
    // on that path that *rebuilds* the URL from its parts instead of rewriting its host, so it is
    // the only place the signature can be lost. Losing it means every cast fails with a 403 that
    // looks, from the sofa, exactly like a network problem.
    const result = (await resolveCastStreamUrl({
      jellyfinBasePath: "https://jellyfin.example.com",
      federatedPath: `https://stingstream.local/stream/${GROUP}/${ITEM_KEY}/${PEER_NODE}${SIG}`,
      // No fetch fixture: every lookup fails, so this lands on the home-node fallback, which is
      // the path a group with no coordinator always takes.
    })) as CastStreamResolution;

    expect(result.via).toBe("home");
    expect(result.url).toBe(
      `https://jellyfin.example.com${suffix(PEER_NODE, SIG)}`,
    );
  });

  test("null for a non-federated path — nothing for the caller to do differently", async () => {
    const result = await resolveCastStreamUrl({
      jellyfinBasePath: "https://jellyfin.example.com",
      federatedPath: "https://jellyfin.example.com/Videos/item-1/stream",
    });
    expect(result).toBeNull();
  });

  test("races the peer's own gossiped side door when the home node's mesh has it", async () => {
    const { impl } = fakeFetch({
      [PEERS_URL]: {
        body: [
          {
            Group: GROUP,
            Node: PEER_NODE,
            NodeName: "loft",
            Online: true,
            SideDoor: {
              node: "peerz32",
              candidates: [
                {
                  kind: "lan",
                  host: "lan.peerz32.direct.example.org",
                  port: 8790,
                  url: "https://lan.peerz32.direct.example.org:8790",
                },
              ],
              updated_at: "2026-09-05T00:00:00Z",
            },
          },
        ],
      },
      "https://lan.peerz32.direct.example.org:8790/sidedoor/v1/hello": {
        body: {
          ok: true,
          node: "peerz32",
          secure: true,
          client_ip: "192.168.1.9",
        },
      },
    });
    globalThis.fetch = impl;

    const result = (await resolveCastStreamUrl({
      jellyfinBasePath: "https://jellyfin.example.com",
      federatedPath: `https://stingstream.local/stream/${GROUP}/${ITEM_KEY}/${PEER_NODE}`,
    })) as CastStreamResolution;

    expect(result.via).toBe("sidedoor");
    expect(result.kind).toBe("lan");
    expect(result.url).toBe(
      `https://lan.peerz32.direct.example.org:8790${suffix(PEER_NODE)}`,
    );
  });

  test("checks the home node's own status when the source node is the home node itself", async () => {
    const { impl } = fakeFetch({
      [PEERS_URL]: { body: [] },
      [STATUS_URL]: {
        body: {
          Node: HOME_NODE,
          NodeName: "attic",
          SideDoor: {
            node: "homez32",
            candidates: [
              {
                kind: "pub",
                host: "pub.homez32.direct.example.org",
                port: 8790,
                url: "https://pub.homez32.direct.example.org:8790",
              },
            ],
            updated_at: "2026-09-05T00:00:00Z",
          },
        },
      },
      "https://pub.homez32.direct.example.org:8790/sidedoor/v1/hello": {
        body: { ok: true, node: "homez32", secure: true },
      },
    });
    globalThis.fetch = impl;

    const result = (await resolveCastStreamUrl({
      jellyfinBasePath: "https://jellyfin.example.com",
      federatedPath: `https://stingstream.local/stream/${GROUP}/${ITEM_KEY}/${HOME_NODE}`,
    })) as CastStreamResolution;

    expect(result.via).toBe("sidedoor");
    expect(result.url).toBe(
      `https://pub.homez32.direct.example.org:8790${suffix(HOME_NODE)}`,
    );
  });

  test("falls back to the home gateway when the peer's node id cannot be turned into a z32 hostname label either", async () => {
    // PEER_NODE is not valid hex, so nodeIdToZ32 rejects it — the coordinator discovery-record
    // path (source 2) has nothing to look up with, on top of the peer carrying no SideDoor
    // (source 1). See the next test for the discovery-record success path with a real hex id.
    const { impl } = fakeFetch({
      [PEERS_URL]: { body: [{ Group: GROUP, Node: PEER_NODE, Online: true }] },
      [GROUPS_URL]: {
        body: [
          {
            Group: GROUP,
            Name: "home",
            Coordinator: "https://coordinator.example.org",
          },
        ],
      },
    });
    globalThis.fetch = impl;

    const result = (await resolveCastStreamUrl({
      jellyfinBasePath: "https://jellyfin.example.com",
      federatedPath: `https://stingstream.local/stream/${GROUP}/${ITEM_KEY}/${PEER_NODE}`,
    })) as CastStreamResolution;

    expect(result.via).toBe("home");
    expect(result.url).toBe(`https://jellyfin.example.com${suffix(PEER_NODE)}`);
  });

  test("falls back to the coordinator's public discovery record when the peer carries no SideDoor field", async () => {
    const hexNode = "ab".repeat(32);
    const z32 = nodeIdToZ32(hexNode)!;
    const coordinator = "https://coordinator.example.org";
    const peersUrl =
      "https://jellyfin.example.com/stingstream/api/v1/mesh/peers?group=g2";
    const { impl } = fakeFetch({
      [peersUrl]: { body: [{ Group: "g2", Node: hexNode, Online: true }] },
      [GROUPS_URL]: {
        body: [{ Group: "g2", Name: "home", Coordinator: coordinator }],
      },
      [`${coordinator}/node/v1/${z32}`]: {
        body: {
          node: z32,
          names: {
            lan: "lan.x.direct.example.org",
            public: "pub.x.direct.example.org",
            relay: "relay.x.direct.example.org",
            wildcard: "*.x.direct.example.org",
            acme_challenge: "_acme-challenge.x.direct.example.org",
          },
        },
      },
      "https://pub.x.direct.example.org:8790/sidedoor/v1/hello": {
        body: { ok: true, node: z32, secure: true },
      },
      "https://lan.x.direct.example.org:8790/sidedoor/v1/hello": {
        status: 500,
      },
      "https://relay.x.direct.example.org:443/sidedoor/v1/hello": {
        status: 500,
      },
    });
    globalThis.fetch = impl;

    const result = (await resolveCastStreamUrl({
      jellyfinBasePath: "https://jellyfin.example.com",
      federatedPath: `https://stingstream.local/stream/g2/${ITEM_KEY}/${hexNode}`,
    })) as CastStreamResolution;

    expect(result.via).toBe("sidedoor");
    expect(result.url).toBe(
      `https://pub.x.direct.example.org:8790/stream/g2/${encodeURIComponent(ITEM_KEY)}/${hexNode}`,
    );
  });

  test("falls back to the home node's own gateway when nothing answers the race", async () => {
    const { impl } = fakeFetch({
      [PEERS_URL]: {
        body: [
          {
            Group: GROUP,
            Node: PEER_NODE,
            Online: false,
            SideDoor: {
              node: "peerz32",
              candidates: [
                {
                  kind: "lan",
                  host: "lan.peerz32.direct.example.org",
                  port: 8790,
                  url: "https://lan.peerz32.direct.example.org:8790",
                },
              ],
              updated_at: "2026-09-05T00:00:00Z",
            },
          },
        ],
      },
      "https://lan.peerz32.direct.example.org:8790/sidedoor/v1/hello": {
        status: 500,
      },
    });
    globalThis.fetch = impl;

    const result = (await resolveCastStreamUrl({
      jellyfinBasePath: "https://jellyfin.example.com",
      federatedPath: `https://stingstream.local/stream/${GROUP}/${ITEM_KEY}/${PEER_NODE}`,
    })) as CastStreamResolution;

    expect(result.via).toBe("home");
    expect(result.url).toBe(`https://jellyfin.example.com${suffix(PEER_NODE)}`);
  });

  test("falls back to the home gateway when the home node's own API is unreachable entirely", async () => {
    globalThis.fetch = (async () =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch;

    const result = (await resolveCastStreamUrl({
      jellyfinBasePath: "https://jellyfin.example.com/jellyfin",
      federatedPath: `https://stingstream.local/stream/${GROUP}/${ITEM_KEY}/${PEER_NODE}`,
    })) as CastStreamResolution;

    expect(result.via).toBe("home");
    // getNodeBaseUrl strips the trailing /jellyfin segment.
    expect(result.url).toBe(`https://jellyfin.example.com${suffix(PEER_NODE)}`);
  });
});
