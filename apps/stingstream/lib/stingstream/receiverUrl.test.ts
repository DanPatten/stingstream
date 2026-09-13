import { afterEach, describe, expect, test } from "bun:test";
import { createReceiverUrlRewriter, isLoopbackUrl } from "./receiverUrl";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BASE = "http://127.0.0.1:5173/jellyfin";
const STATUS_URL = "http://127.0.0.1:5173/stingstream/api/v1/mesh/status";
const NODE = "homez32";

/** A `fetch` that answers only the URLs it is told about; anything else rejects. */
function fakeFetch(routes: Record<string, unknown>) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url.toString();
    if (!(href in routes)) throw new Error(`unexpected fetch: ${href}`);
    return new Response(JSON.stringify(routes[href]));
  }) as unknown as typeof fetch;
}

const status = (sideDoor: unknown) => ({
  Node: "home0000homenodehex",
  ServerName: "attic",
  SideDoor: sideDoor,
});

const hello = { ok: true, node: NODE, secure: true };

describe("isLoopbackUrl", () => {
  test("recognises every loopback spelling", () => {
    expect(isLoopbackUrl("http://127.0.0.1:5173/x")).toBe(true);
    expect(isLoopbackUrl("http://127.8.0.1/x")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8790")).toBe(true);
    expect(isLoopbackUrl("http://node.localhost/x")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8790/x")).toBe(true);
  });

  test("leaves LAN, public and garbage alone", () => {
    expect(isLoopbackUrl("http://192.168.0.16:8790/x")).toBe(false);
    expect(isLoopbackUrl("https://media.example.com/x")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});

describe("createReceiverUrlRewriter", () => {
  test("a LAN client pays for no lookup and gets its URLs back untouched", async () => {
    fakeFetch({});
    const rewrite = await createReceiverUrlRewriter({
      jellyfinBasePath: "http://192.168.0.16:8790/jellyfin",
    });
    const url = "http://192.168.0.16:8790/jellyfin/Videos/1/stream?ApiKey=k";
    expect(rewrite(url)).toBe(url);
  });

  test("swaps a loopback origin for the node's side door, keeping path and query exactly", async () => {
    fakeFetch({
      [STATUS_URL]: status({
        node: NODE,
        candidates: [
          {
            kind: "own",
            host: "media.example.com",
            port: 443,
            url: "https://media.example.com",
          },
        ],
      }),
      "https://media.example.com/sidedoor/v1/hello": hello,
    });
    const rewrite = await createReceiverUrlRewriter({
      jellyfinBasePath: BASE,
      raceTimeoutMs: 200,
    });
    expect(
      rewrite(
        "http://127.0.0.1:5173/jellyfin/Videos/1/stream?static=true&ApiKey=a%2Fb",
      ),
    ).toBe(
      "https://media.example.com/jellyfin/Videos/1/stream?static=true&ApiKey=a%2Fb",
    );
    // A signed mesh URL: the query is the signature, so it must survive untouched.
    expect(
      rewrite("http://127.0.0.1:5173/stream/g1/movie%3A1/peer?exp=1&sig=ab"),
    ).toBe("https://media.example.com/stream/g1/movie%3A1/peer?exp=1&sig=ab");
    // A third-party subtitle host is not ours to rewrite.
    expect(rewrite("https://subs.example.org/a.vtt")).toBe(
      "https://subs.example.org/a.vtt",
    );
  });

  test("falls back to the node's plain-HTTP LAN address when that is all it has", async () => {
    fakeFetch({
      [STATUS_URL]: status({
        node: NODE,
        candidates: [],
        lan_ips: ["192.168.0.16"],
        http_port: 8790,
      }),
      "http://192.168.0.16:8790/sidedoor/v1/hello": hello,
    });
    const rewrite = await createReceiverUrlRewriter({
      jellyfinBasePath: BASE,
      raceTimeoutMs: 200,
    });
    expect(
      rewrite("http://127.0.0.1:5173/jellyfin/Items/1/Images/Primary"),
    ).toBe("http://192.168.0.16:8790/jellyfin/Items/1/Images/Primary");
  });

  test("no side door record: URLs come back unchanged rather than failing the cast", async () => {
    fakeFetch({ [STATUS_URL]: status(null) });
    const rewrite = await createReceiverUrlRewriter({ jellyfinBasePath: BASE });
    const url = "http://127.0.0.1:5173/jellyfin/Videos/1/stream";
    expect(rewrite(url)).toBe(url);
  });

  test("a node that does not answer at all: unchanged too", async () => {
    fakeFetch({});
    const rewrite = await createReceiverUrlRewriter({
      jellyfinBasePath: BASE,
      lookupTimeoutMs: 200,
    });
    const url = "http://127.0.0.1:5173/jellyfin/Videos/1/stream";
    expect(rewrite(url)).toBe(url);
  });
});
