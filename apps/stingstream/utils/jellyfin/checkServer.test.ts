import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  setJellyfinHeaders,
  stubCustomHeaders,
} from "@/test-utils/customHeaders";
import type { CustomHeader } from "@/utils/customHeaders/types";

// checkServer pulls the two helpers through the barrel file, which also
// re-exports modules with native dependencies (MMKV, SecureStore) — so the
// barrel is replaced with just the real implementations of what it needs.
stubCustomHeaders();
// No proxy headers in these specs, set per test so another file cannot
// leave its own behind.
beforeEach(() => setJellyfinHeaders());

// Bun's mock.module retroactively re-links every module already importing the
// specifier, so a log mock must cover the module's full function surface —
// a missing name breaks OTHER test files' modules that import it.
const loggedMessages: Array<{ level: string; message: string }> = [];
mock.module("@/utils/log", () => ({
  writeToLog: (level: string, message: string) => {
    loggedMessages.push({ level, message });
  },
  writeInfoLog: (message: string) => {
    loggedMessages.push({ level: "INFO", message });
  },
  writeErrorLog: (message: string) => {
    loggedMessages.push({ level: "ERROR", message });
  },
  writeDebugLog: () => undefined,
  logAndCaptureError: (message: string) => {
    loggedMessages.push({ level: "ERROR", message });
  },
  readFromLog: () => [],
}));

const savedHeaders = new Map<string, CustomHeader[]>();
const persistedHeaders: Array<{ url: string; headers: CustomHeader[] }> = [];
mock.module("@/utils/secureCredentials", () => ({
  getServerCustomHeaders: (url: string) => savedHeaders.get(url) ?? [],
  updateServerCustomHeaders: (url: string, headers: CustomHeader[]) => {
    persistedHeaders.push({ url, headers });
  },
}));

const { checkJellyfinServer, NotAJellyfinServerError, ServerTooOldError } =
  await import("./checkServer");

// --- fetch stub ------------------------------------------------------------

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let fetchCalls: FetchCall[] = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) => {
  fetchCalls.push({ url, init });
  return fetchImpl(url, init);
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
});

const okResponse = (body: Record<string, unknown> = {}): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ Version: "10.10.7", ServerName: "Homelab", ...body }),
  }) as Response;

const statusResponse = (status: number): Response =>
  ({ ok: false, status, json: async () => ({}) }) as Response;

/** A StingStream node's gateway placeholder: HTTP 200, and HTML. */
const htmlResponse = (): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    },
  }) as unknown as Response;

/** 200 with JSON that is not a Jellyfin document — a proxy's own status page, say. */
const jsonArrayResponse = (): Response =>
  ({ ok: true, status: 200, json: async () => [] }) as unknown as Response;

const networkError = () =>
  Promise.reject(new TypeError("Network request failed"));

/** Simulates a socket that accepts but never answers — only the caller's
 * abort signal ends it, like a plain-HTTP port receiving a TLS handshake. */
const hangUntilAborted = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
  });

/** Routes by protocol so tests can script https and http independently. */
const routes = (impl: {
  https?: (init?: RequestInit) => Promise<Response>;
  http?: (init?: RequestInit) => Promise<Response>;
}) => {
  fetchImpl = (url, init) =>
    url.startsWith("https://")
      ? (impl.https ?? networkError)(init)
      : (impl.http ?? networkError)(init);
};

beforeEach(() => {
  fetchCalls = [];
  loggedMessages.length = 0;
  savedHeaders.clear();
  persistedHeaders.length = 0;
  fetchImpl = networkError;
});

const header = (key: string, value: string): CustomHeader => ({
  key,
  value,
  enabled: true,
});

// --- scheme handling -------------------------------------------------------
// Regression tests for "local IP with a typed http:// won't connect": the
// probe used to discard the typed scheme and always try https first, which
// can hang against a plain-HTTP port on a LAN IP.

describe("checkJellyfinServer scheme handling", () => {
  test("a typed http:// is trusted as-is — no https probe is ever made", async () => {
    routes({ http: async () => okResponse() });

    const result = await checkJellyfinServer("http://192.168.1.10:8096");

    expect(result).toEqual({
      url: "http://192.168.1.10:8096",
      name: "Homelab",
    });
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "http://192.168.1.10:8096/System/Info/Public",
    ]);
  });

  test("a typed https:// is never silently downgraded to http", async () => {
    routes({}); // everything unreachable

    const result = await checkJellyfinServer("https://media.example.com");

    expect(result).toBeUndefined();
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "https://media.example.com/System/Info/Public",
    ]);
  });

  test("schemeless input probes https first, then falls back to http", async () => {
    routes({ https: networkError, http: async () => okResponse() });

    const result = await checkJellyfinServer("192.168.1.10:8096");

    expect(result).toEqual({
      url: "http://192.168.1.10:8096",
      name: "Homelab",
    });
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "https://192.168.1.10:8096/System/Info/Public",
      "http://192.168.1.10:8096/System/Info/Public",
    ]);
  });

  test("the typed scheme survives casing and surrounding whitespace", async () => {
    routes({ http: async () => okResponse() });

    const result = await checkJellyfinServer("  HTTP://192.168.1.10:8096  ");

    expect(result?.url).toBe("http://192.168.1.10:8096");
    expect(fetchCalls).toHaveLength(1);
  });

  test("port and path are preserved verbatim", async () => {
    routes({ http: async () => okResponse() });

    const result = await checkJellyfinServer("http://10.0.0.5:3000/jellyfin");

    expect(result?.url).toBe("http://10.0.0.5:3000/jellyfin");
    expect(fetchCalls[0]?.url).toBe(
      "http://10.0.0.5:3000/jellyfin/System/Info/Public",
    );
  });
});

// --- probe robustness ------------------------------------------------------

describe("checkJellyfinServer probing", () => {
  test("a hanging candidate is aborted after the timeout instead of blocking the fallback", async () => {
    routes({ https: hangUntilAborted, http: async () => okResponse() });

    const result = await checkJellyfinServer(
      "192.168.1.10:8096",
      undefined,
      20,
    );

    expect(result?.url).toBe("http://192.168.1.10:8096");
    // Probe failures are routine (fallback still succeeds here), so they log
    // as WARN — local trail only, never a Sentry event.
    expect(
      loggedMessages.some(
        (m) => m.level === "WARN" && m.message.includes("timed out after 20ms"),
      ),
    ).toBeTrue();
  });

  test("a non-OK https answer (e.g. a gateway 403) still falls through to http", async () => {
    routes({
      https: async () => statusResponse(403),
      http: async () => okResponse(),
    });

    const result = await checkJellyfinServer("192.168.1.10:8096");

    expect(result?.url).toBe("http://192.168.1.10:8096");
    expect(
      loggedMessages.some(
        (m) => m.level === "WARN" && m.message.includes("HTTP 403"),
      ),
    ).toBeTrue();
  });

  test("returns undefined when nothing answers", async () => {
    routes({});

    const result = await checkJellyfinServer("192.168.1.10:8096");

    expect(result).toBeUndefined();
    expect(fetchCalls).toHaveLength(2);
  });

  test("a server older than 10.10 throws ServerTooOldError", async () => {
    routes({ http: async () => okResponse({ Version: "10.8.13" }) });

    await expect(
      checkJellyfinServer("http://192.168.1.10:8096"),
    ).rejects.toThrow(ServerTooOldError);
  });

  test("an unparseable version is given the benefit of the doubt", async () => {
    routes({ http: async () => okResponse({ Version: "unstable" }) });

    const result = await checkJellyfinServer("http://192.168.1.10:8096");

    expect(result?.url).toBe("http://192.168.1.10:8096");
  });
});

// --- custom headers --------------------------------------------------------

describe("checkJellyfinServer custom headers", () => {
  test("typed headers are sent with the probe and persisted only for the URL that answered", async () => {
    routes({ https: networkError, http: async () => okResponse() });
    const typed = [header("CF-Access-Client-Id", "abc")];

    await checkJellyfinServer("192.168.1.10:8096", typed);

    const httpCall = fetchCalls.find((c) => c.url.startsWith("http://"));
    expect(
      (httpCall?.init as { headers?: Record<string, string> })?.headers,
    ).toEqual({ "CF-Access-Client-Id": "abc" });
    expect(persistedHeaders).toEqual([
      { url: "http://192.168.1.10:8096", headers: typed },
    ]);
  });

  test("saved headers are reused when none are passed, and nothing is re-persisted", async () => {
    savedHeaders.set("http://192.168.1.10:8096", [
      header("CF-Access-Client-Id", "saved"),
    ]);
    routes({ http: async () => okResponse() });

    await checkJellyfinServer("http://192.168.1.10:8096");

    expect(
      (fetchCalls[0]?.init as { headers?: Record<string, string> })?.headers,
    ).toEqual({ "CF-Access-Client-Id": "saved" });
    expect(persistedHeaders).toHaveLength(0);
  });

  test("headers that fail to reach the server are not persisted", async () => {
    routes({});

    await checkJellyfinServer("192.168.1.10:8096", [
      header("CF-Access-Client-Id", "abc"),
    ]);

    expect(persistedHeaders).toHaveLength(0);
  });
});

// --- Jellyfin under /jellyfin ----------------------------------------------
// A StingStream node's gateway serves Jellyfin at /jellyfin and answers every path it does not
// know with its own placeholder page at HTTP 200. Before this, typing the node's own address —
// the address on its own status screen, and the one anybody would try first — got HTML where the
// check wanted JSON, and the user was told to check their network connection.

describe("checkJellyfinServer finds Jellyfin under /jellyfin", () => {
  test("an HTML answer at the root is retried one level down, and that base is adopted", async () => {
    fetchImpl = async (url) =>
      url.startsWith("http://node.local:8890/jellyfin/")
        ? okResponse({ ServerName: "stingstream-a" })
        : htmlResponse();

    const result = await checkJellyfinServer("http://node.local:8890");

    expect(result).toEqual({
      url: "http://node.local:8890/jellyfin",
      name: "stingstream-a",
    });
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "http://node.local:8890/System/Info/Public",
      "http://node.local:8890/jellyfin/System/Info/Public",
    ]);
  });

  test("JSON that is not a Jellyfin document counts as not-Jellyfin too", async () => {
    fetchImpl = async (url) =>
      url.includes("/jellyfin/") ? okResponse() : jsonArrayResponse();

    const result = await checkJellyfinServer("http://node.local:8890");

    expect(result?.url).toBe("http://node.local:8890/jellyfin");
  });

  test("a real Jellyfin at the root is never asked about /jellyfin", async () => {
    routes({ http: async () => okResponse() });

    await checkJellyfinServer("http://192.168.1.10:8096");

    expect(fetchCalls.map((c) => c.url)).toEqual([
      "http://192.168.1.10:8096/System/Info/Public",
    ]);
  });

  test("an address that already says /jellyfin is not doubled up", async () => {
    fetchImpl = async () => htmlResponse();

    await expect(
      checkJellyfinServer("http://node.local:8890/jellyfin"),
    ).rejects.toBeInstanceOf(NotAJellyfinServerError);

    expect(fetchCalls.map((c) => c.url)).toEqual([
      "http://node.local:8890/jellyfin/System/Info/Public",
    ]);
  });

  test("HTML at both levels is a distinct error, not 'could not connect'", async () => {
    fetchImpl = async () => htmlResponse();

    await expect(
      checkJellyfinServer("http://node.local:8890"),
    ).rejects.toBeInstanceOf(NotAJellyfinServerError);
  });

  test("nothing answering at all is still undefined, not the not-Jellyfin error", async () => {
    routes({});

    expect(
      await checkJellyfinServer("http://192.168.1.10:8096"),
    ).toBeUndefined();
  });

  test("a node that 404s the root — the newer gateway — is followed to /jellyfin too", async () => {
    // The gateway's own half of this fix answers Jellyfin-shaped paths at the root with 404 and
    // JSON instead of the placeholder page. If the app only followed HTML, that fix would have
    // silently undone this one, so the rule is "something answered", not "it was HTML".
    fetchImpl = async (url) =>
      url.includes("/jellyfin/")
        ? okResponse({ ServerName: "stingstream-a" })
        : statusResponse(404);

    const result = await checkJellyfinServer("http://node.local:8890");

    expect(result).toEqual({
      url: "http://node.local:8890/jellyfin",
      name: "stingstream-a",
    });
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "http://node.local:8890/System/Info/Public",
      "http://node.local:8890/jellyfin/System/Info/Public",
    ]);
  });

  test("something that answers but is Jellyfin at neither level is the distinct error", async () => {
    fetchImpl = async () => statusResponse(404);

    await expect(
      checkJellyfinServer("http://192.168.1.10:8096"),
    ).rejects.toBeInstanceOf(NotAJellyfinServerError);
  });

  test("an unreachable address is not probed twice — the timeout must not double", async () => {
    routes({});

    expect(
      await checkJellyfinServer("http://192.168.1.10:8096"),
    ).toBeUndefined();
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "http://192.168.1.10:8096/System/Info/Public",
    ]);
  });

  test("headers are carried to the nested probe and persisted against the base that answered", async () => {
    const typed = [header("CF-Access-Client-Id", "abc")];
    fetchImpl = async (url) =>
      url.includes("/jellyfin/") ? okResponse() : htmlResponse();

    await checkJellyfinServer("http://node.local:8890", typed);

    expect(
      (fetchCalls[1]?.init as { headers?: Record<string, string> })?.headers,
    ).toEqual({ "CF-Access-Client-Id": "abc" });
    expect(persistedHeaders).toEqual([
      { url: "http://node.local:8890/jellyfin", headers: typed },
    ]);
  });

  test("a schemeless address still tries https first, then http, before going down a level", async () => {
    fetchImpl = async (url) =>
      url.startsWith("http://node.local:8890/jellyfin/")
        ? okResponse()
        : url.startsWith("https://")
          ? networkError()
          : htmlResponse();

    const result = await checkJellyfinServer("node.local:8890");

    expect(result?.url).toBe("http://node.local:8890/jellyfin");
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "https://node.local:8890/System/Info/Public",
      "http://node.local:8890/System/Info/Public",
      "http://node.local:8890/jellyfin/System/Info/Public",
    ]);
  });

  test("an old Jellyfin under /jellyfin still reports its age, not a missing server", async () => {
    fetchImpl = async (url) =>
      url.includes("/jellyfin/")
        ? okResponse({ Version: "10.9.0" })
        : htmlResponse();

    await expect(
      checkJellyfinServer("http://node.local:8890"),
    ).rejects.toBeInstanceOf(ServerTooOldError);
  });
});
