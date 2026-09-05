import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearMeshRewriteContext,
  getMeshRewriteContext,
  isMeshStreamUrl,
  type MeshRewriteContext,
  parseMeshStreamUrl,
  rewriteMeshStreamUrl,
  rewriteStreamUrlForMesh,
  setMeshRewriteContext,
} from "./streamUrl";

const GROUP =
  "2ee6304f1deb0beee080bcee5d621a502b37b5ec7c0e20eda4bf3cdcf6a86523";
const NODE = "0d5cd6dbcb04eb38cb7a4c35f43b4d0af4753fa32c971b85dd2d4969b216bcff";
const ITEM = "movie:tmdb:16205";

const url = (path = `/stream/${GROUP}/${ITEM}/${NODE}`) =>
  `https://stingstream.local${path}`;

const running = (
  overrides: Partial<MeshRewriteContext> = {},
): MeshRewriteContext => ({
  available: true,
  localPort: 43210,
  groups: [GROUP],
  ...overrides,
});

describe("parseMeshStreamUrl", () => {
  test("splits the four segments a federated .strm carries", () => {
    expect(parseMeshStreamUrl(url())).toEqual({
      group: GROUP,
      itemKey: ITEM,
      node: NODE,
      suffix: "",
    });
  });

  test("keeps the item key percent-encoded, because the mesh decodes it itself", () => {
    const encoded = "movie%3Atmdb%3A16205";
    expect(
      parseMeshStreamUrl(url(`/stream/${GROUP}/${encoded}/${NODE}`))?.itemKey,
    ).toBe(encoded);
  });

  test("keeps a query string and a fragment", () => {
    expect(parseMeshStreamUrl(`${url()}?t=42#frag`)?.suffix).toBe("?t=42#frag");
  });

  test("accepts http and an explicit port, so an older pointer still works", () => {
    expect(
      parseMeshStreamUrl(
        `http://stingstream.local/stream/${GROUP}/${ITEM}/${NODE}`,
      ),
    ).not.toBeNull();
    expect(
      parseMeshStreamUrl(
        `https://stingstream.local:8790/stream/${GROUP}/${ITEM}/${NODE}`,
      ),
    ).not.toBeNull();
  });

  test("is case-insensitive about the host", () => {
    expect(
      parseMeshStreamUrl(
        `https://StingStream.Local/stream/${GROUP}/${ITEM}/${NODE}`,
      ),
    ).not.toBeNull();
  });

  test("rejects anything that is not exactly this shape", () => {
    expect(parseMeshStreamUrl(null)).toBeNull();
    expect(parseMeshStreamUrl("")).toBeNull();
    // An ordinary Jellyfin URL.
    expect(
      parseMeshStreamUrl(
        "https://jellyfin.example.com/Videos/abc/stream?static=true",
      ),
    ).toBeNull();
    // A look-alike host: a subdomain of somebody else's domain must not be rewritten.
    expect(
      parseMeshStreamUrl(
        `https://stingstream.local.evil.example/stream/${GROUP}/${ITEM}/${NODE}`,
      ),
    ).toBeNull();
    expect(
      parseMeshStreamUrl(
        `https://notstingstream.local/stream/${GROUP}/${ITEM}/${NODE}`,
      ),
    ).toBeNull();
    // The right host, the wrong path.
    expect(
      parseMeshStreamUrl("https://stingstream.local/mesh/v1/status"),
    ).toBeNull();
    // Too few and too many segments.
    expect(
      parseMeshStreamUrl(`https://stingstream.local/stream/${GROUP}/${ITEM}`),
    ).toBeNull();
    expect(
      parseMeshStreamUrl(
        `https://stingstream.local/stream/${GROUP}/${ITEM}/${NODE}/extra`,
      ),
    ).toBeNull();
  });
});

describe("rewriteMeshStreamUrl", () => {
  test("points a joined group's stream at the loopback port", () => {
    expect(rewriteMeshStreamUrl(url(), running())).toBe(
      `http://127.0.0.1:43210/stream/${GROUP}/${ITEM}/${NODE}`,
    );
  });

  test("carries the query string and fragment across", () => {
    expect(rewriteMeshStreamUrl(`${url()}?start=90`, running())).toBe(
      `http://127.0.0.1:43210/stream/${GROUP}/${ITEM}/${NODE}?start=90`,
    );
  });

  test("leaves the URL alone when the module is unavailable, so web plays through the home node", () => {
    const web = running({ available: false });
    expect(rewriteMeshStreamUrl(url(), web)).toBe(url());
  });

  test("leaves the URL alone when the node is not listening", () => {
    expect(rewriteMeshStreamUrl(url(), running({ localPort: 0 }))).toBe(url());
  });

  test("leaves the URL alone for a group this device has not joined", () => {
    // Dialling a group we are not a member of would fail the peer handshake and stall the
    // player; the home node can proxy it instead.
    const other = running({ groups: ["ff".repeat(32)] });
    expect(rewriteMeshStreamUrl(url(), other)).toBe(url());
  });

  test("matches the group id without case, because hex is written both ways", () => {
    const upper = running({ groups: [GROUP.toUpperCase()] });
    expect(rewriteMeshStreamUrl(url(), upper)).toStartWith(
      "http://127.0.0.1:43210/",
    );
  });

  test("never touches an ordinary Jellyfin stream URL", () => {
    const jellyfin =
      "https://jellyfin.example.com/Videos/abc/stream?static=true&ApiKey=SECRET";
    expect(rewriteMeshStreamUrl(jellyfin, running())).toBe(jellyfin);
  });

  test("is idempotent: a rewritten URL is no longer a mesh URL", () => {
    const once = rewriteMeshStreamUrl(url(), running());
    expect(rewriteMeshStreamUrl(once, running())).toBe(once);
  });
});

describe("the live context", () => {
  beforeEach(() => clearMeshRewriteContext());

  test("defaults to not-running, so nothing is rewritten before the node starts", () => {
    expect(getMeshRewriteContext().available).toBe(false);
    expect(rewriteStreamUrlForMesh(url())).toBe(url());
  });

  test("rewrites once the provider has published a running node", () => {
    setMeshRewriteContext(running());
    expect(rewriteStreamUrlForMesh(url())).toBe(
      `http://127.0.0.1:43210/stream/${GROUP}/${ITEM}/${NODE}`,
    );
  });

  test("stops rewriting after the context is cleared on logout", () => {
    setMeshRewriteContext(running());
    clearMeshRewriteContext();
    expect(rewriteStreamUrlForMesh(url())).toBe(url());
  });

  test("copies the group list, so a later mutation cannot change a live session", () => {
    const groups = [GROUP];
    setMeshRewriteContext(running({ groups }));
    groups.length = 0;
    expect(rewriteStreamUrlForMesh(url())).toStartWith(
      "http://127.0.0.1:43210/",
    );
  });

  test("passes null and undefined straight through", () => {
    setMeshRewriteContext(running());
    expect(rewriteStreamUrlForMesh(null)).toBeNull();
    expect(rewriteStreamUrlForMesh(undefined)).toBeUndefined();
  });
});

describe("isMeshStreamUrl", () => {
  test("recognises a mesh URL whether or not the node is running", () => {
    clearMeshRewriteContext();
    expect(isMeshStreamUrl(url())).toBe(true);
    expect(
      isMeshStreamUrl("https://jellyfin.example.com/Videos/a/stream"),
    ).toBe(false);
    expect(isMeshStreamUrl(undefined)).toBe(false);
  });
});
