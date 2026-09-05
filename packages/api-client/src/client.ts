import createClient, { type Client } from "openapi-fetch";
import { getNodeBaseUrl } from "./node-url";
import type { paths } from "./types.gen";

export interface StingStreamClientOptions {
  /**
   * The Jellyfin server URL the app is already connected to
   * (`api.basePath` from `@jellyfin/sdk`, e.g.
   * `http://192.168.1.5:8790/jellyfin`). The StingStream API lives on the
   * same node, one path prefix over — see `getStingStreamApiBaseUrl`.
   */
  jellyfinBasePath: string;
  /**
   * The same access token used for Jellyfin calls (`api.accessToken`).
   * StingStream.Core *is* Jellyfin's auth: any user token valid against this
   * node's Jellyfin is valid here too, and Core applies Jellyfin's own admin
   * policy per endpoint.
   */
  accessToken?: string | null;
  /** Extra headers, mainly for tests / custom-proxy setups. */
  extraHeaders?: Record<string, string>;
}

export type StingStreamClient = Client<paths>;

/**
 * Builds a typed client for `/stingstream/api/v1/*`, generated from the
 * OpenAPI document StingStream.Core publishes at
 * `/stingstream/api/v1/openapi.json`. See README.md for regeneration.
 *
 * The `baseUrl` here is the node's origin only (e.g. `http://host:8790`),
 * NOT `.../stingstream/api/v1` — `openapi-typescript` generates `paths` keys
 * as the full absolute path from the document's own root (`/stingstream/api/v1/Settings`,
 * etc; the OpenAPI document's own `servers` entry, `/jellyfin`, describes
 * Core's *other* mount point inside Jellyfin's own routing and is not used
 * here), and `openapi-fetch` concatenates `baseUrl + path` verbatim. Passing
 * the API prefix as `baseUrl` here previously double-prefixed every request
 * (`/stingstream/api/v1/stingstream/api/v1/Settings`, a 404) — caught by
 * exercising the real app against a real node, not by the type checker,
 * since the concatenation is a runtime string join with no type to catch it.
 */
export function createStingStreamClient(
  opts: StingStreamClientOptions,
): StingStreamClient {
  const baseUrl = getNodeBaseUrl(opts.jellyfinBasePath);
  const headers: Record<string, string> = { ...opts.extraHeaders };
  if (opts.accessToken) {
    headers.Authorization = `MediaBrowser Token="${opts.accessToken}"`;
  }
  return createClient<paths>({ baseUrl, headers });
}
