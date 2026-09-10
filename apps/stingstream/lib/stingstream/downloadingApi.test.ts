import { afterEach, describe, expect, test } from "bun:test";
import {
  DownloadingUnmanagedError,
  fetchDownloading,
  saveDownloading,
} from "./downloadingApi";

/**
 * The switch that decides whether this server fetches anything.
 *
 * The wire half only — `bun:test` cannot load the hooks' import graph
 * (`providers/JellyfinProvider` reaches a native `codegenNativeComponent`), which is exactly why
 * `downloadingApi.ts` is separate from `downloading.ts`.
 */

const BASE = "https://node.example.com/stingstream/api/v1";
const realFetch = globalThis.fetch;

const stub = (status: number, body: unknown) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: typeof url === "string" ? url : url.toString(), init });
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
    });
  }) as unknown as typeof fetch;
  return calls;
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchDownloading", () => {
  test("reads the PascalCase a Jellyfin-hosted controller actually answers with", async () => {
    // Measured against a live node: the base controller documents this API as camelCase, and
    // Jellyfin's serializer sends `Films`. A client that believed the documentation showed every
    // switch off on a server that was downloading perfectly well.
    stub(200, { Films: true, Series: false, Usenet: false });

    expect(await fetchDownloading(BASE)).toEqual({
      films: true,
      series: false,
      usenet: false,
    });
  });

  test("reads camelCase too, so the answer does not depend on whose serializer ran", async () => {
    stub(200, { films: false, series: true, usenet: true });

    expect(await fetchDownloading(BASE)).toEqual({
      films: false,
      series: true,
      usenet: true,
    });
  });

  test("a switch the node does not mention is null, not false", async () => {
    // `null` is "this server did not say"; `false` is "off". Collapsing them would draw a switch
    // in the off position for something that may well be running.
    stub(200, { Films: true });

    expect(await fetchDownloading(BASE)).toEqual({
      films: true,
      series: null,
      usenet: null,
    });
  });

  test("503 is a server nobody supervises, not a server with downloading off", async () => {
    stub(503, undefined);

    await expect(fetchDownloading(BASE)).rejects.toBeInstanceOf(
      DownloadingUnmanagedError,
    );
  });
});

describe("saveDownloading", () => {
  test("sends only the switch it was given", async () => {
    // The server leaves an omitted switch alone, which is what stops one screen turning off
    // something another screen never showed.
    const calls = stub(200, { Films: true, Series: false, Usenet: false });
    await saveDownloading(BASE, { films: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/downloading`);
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ films: true });
  });

  test("carries the node's own error text back to the caller", async () => {
    stub(400, {
      error: "config.toml has no [children] radarr line to change.",
    });

    await expect(saveDownloading(BASE, { films: true })).rejects.toThrow(
      "config.toml has no [children] radarr line to change.",
    );
  });
});
