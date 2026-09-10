/**
 * The wire for `/stingstream/api/v1/downloading` — types, shaping, and plain `fetch`.
 *
 * Three child processes do the fetching, `config.toml` decides whether they run, and
 * `DownloadingController` writes that file. The supervisor is watching it and starts or stops them
 * within a few seconds (`supervisor::downloading`), which is why this module reads *two* sources
 * and they mean different things:
 *
 * - `useDownloading` is the **switch position** — what the server has been told to do.
 * - `/healthz`, through `useDownloadingHealth`, is **what is actually running**.
 *
 * A screen that showed only the first would say "on" the instant a button was pressed and go on
 * saying it even if nothing ever started; one that showed only the second would snap the switch
 * back under the reader's finger for the few seconds before the process is up. Both, labelled
 * honestly, is the only version that is not lying at some point in the sequence.
 *
 * **No React here.** The hooks live in `./downloading`, and this half imports nothing that reaches
 * `providers/JellyfinProvider` — whose import graph `bun:test` cannot load at all (a native
 * `codegenNativeComponent` a few layers down). Same split as `requestsApi.ts` / `requests.ts`, and
 * it is what makes any of this testable.
 *
 * **Plain `fetch`, not the generated client.** Every other call in this app goes through the typed
 * client built from `packages/api-client/openapi.json`, and this one will too — but regenerating
 * that document means running a node built from this working tree, which on a shared checkout
 * picks up whatever other controllers are half-written at that moment (see the note in
 * `docs/CONTRIBUTING.md` about the generated client). The two paths below are pinned by the
 * controller's own route attribute; move them onto the typed client the next time the document is
 * regenerated for other reasons.
 */

const PATH = "/downloading";

export interface DownloadingSettings {
  /** Whether this node fetches films. */
  films?: boolean | null;
  /** Whether this node fetches series. */
  series?: boolean | null;
  /** Whether this node fetches over usenet as well as over BitTorrent. */
  usenet?: boolean | null;
}

/** The three switches, in the order a screen shows them. */
export const DOWNLOADING_KEYS = ["films", "series", "usenet"] as const;
export type DownloadingKey = (typeof DOWNLOADING_KEYS)[number];

/** Which child answers for each switch, for reading `/healthz`. */
export const CHILD_FOR: Record<DownloadingKey, string> = {
  films: "radarr",
  series: "sonarr",
  usenet: "nzbget",
};

const authHeaders = (token?: string | null): Record<string, string> =>
  token ? { Authorization: `MediaBrowser Token="${token}"` } : {};

/**
 * Read the node's answer whichever case it arrives in.
 *
 * StingStream's controllers are hosted inside Jellyfin, and Jellyfin's serializer names properties
 * `Films`/`Series`/`Usenet` even though this API's own base controller documents itself as
 * camelCase. `requestsApi.ts` deals with the same split the same way, and for the same reason: the
 * casing is a property of whose serializer ran, not of the API's contract, and a client that
 * assumed either one would break the first time that changed. Measured against a live node before
 * this existed -- the switch read as off with the file plainly saying `true`.
 *
 * Sending is unaffected: ASP.NET binds an incoming body case-insensitively.
 */
const toSettings = (body: unknown): DownloadingSettings => {
  const raw = (body ?? {}) as Record<string, unknown>;
  const read = (key: "films" | "series" | "usenet"): boolean | null => {
    const value =
      raw[key] ?? raw[`${key[0].toUpperCase()}${key.slice(1)}` as string];
    return typeof value === "boolean" ? value : null;
  };
  return {
    films: read("films"),
    series: read("series"),
    usenet: read("usenet"),
  };
};

/**
 * The node was not started by the supervisor, so there is no `config.toml` to read or write.
 *
 * Its own type for the same reason `RequestsUnavailableError` is: "downloading is off" and "this
 * server cannot answer the question at all" look alike in a body and are opposite things to show
 * somebody. A developer running Jellyfin directly gets the second, and must not be shown a switch
 * that cannot do anything.
 */
export class DownloadingUnmanagedError extends Error {
  readonly unmanaged = true;
}

async function readError(res: Response, what: string): Promise<Error> {
  if (res.status === 503) {
    return new DownloadingUnmanagedError(
      "This server is not managed by StingStream, so downloading cannot be switched here.",
    );
  }
  let detail = "";
  try {
    const body = (await res.json()) as { error?: string; title?: string };
    detail = body.error ?? body.title ?? "";
  } catch {
    // A body that is not JSON tells us nothing the status has not already.
  }
  return new Error(detail || `${what} failed (${res.status})`);
}

export async function fetchDownloading(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<DownloadingSettings> {
  const res = await fetch(`${apiBaseUrl}${PATH}`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /downloading");
  return toSettings(await res.json());
}

export async function saveDownloading(
  apiBaseUrl: string,
  settings: DownloadingSettings,
  accessToken?: string | null,
): Promise<DownloadingSettings> {
  const res = await fetch(`${apiBaseUrl}${PATH}`, {
    method: "PUT",
    headers: {
      ...authHeaders(accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw await readError(res, "PUT /downloading");
  return toSettings(await res.json());
}
