/**
 * `GET /stingstream/api/v1/items/{id}/sources` — every source this node's `StingStream.Core`
 * could play a federated title from, scored by the same formula PlaybackInfo uses
 * (`docs/ARCHITECTURE.md`, "The scoring formula, as built"), best first.
 *
 * Hand-written for the same reason `lib/stingstream/mesh.ts` is: `packages/api-client`'s snapshot
 * of the OpenAPI document predates `ItemsController` (M4), and regenerating it needs a live node.
 * `ItemsController` derives from the same `StingStreamControllerBase` as `MeshController`, so it
 * carries the same PascalCase surprise (`docs/APP-MESH.md` §6) — Core is hosted inside Jellyfin,
 * whose global `JsonSerializerOptions` are PascalCase, and the controller base only overrides the
 * `[Produces]` media types. This file reads either casing for the same reason `mesh.ts` does.
 *
 * ## Why the download path wants this instead of just PlaybackInfo
 *
 * PlaybackInfo already returns a federated item's `MediaSources` in scored order (M4), which is
 * what native playback plays without needing this endpoint at all. But it can only return sources
 * Jellyfin has *items* for — this node's federated-library materializer writes one `.strm` per
 * holding node, and a title held locally is not materialized at all (the local file wins), so its
 * remote copies never appear as alternate MediaSources even though they are perfectly good
 * candidates for a *download* that wants the fastest holder rather than "the one file this node
 * happens to have a Jellyfin item for." `GET /items/{id}/sources` sees the whole group; PlaybackInfo
 * only sees what got materialized.
 */

/** One scored source, as `ItemsController.Present` shapes it. */
export interface ItemSource {
  node: string;
  nodeName: string;
  group: string;
  online: boolean;
  resolution?: string | null;
  width?: number | null;
  height?: number | null;
  bitrate?: number | null;
  sizeBytes?: number | null;
  /** BLAKE3 of the holder's file — the `stingstream:file_hash` tag PlaybackInfo's ETag also carries. */
  fileHash?: string | null;
  /** `direct`, `mixed`, `relay`, or absent before any connection. */
  path?: string | null;
  rttMs?: number | null;
  throughputBps?: number | null;
  maxDirectStreams?: number | null;
  activeDirectStreams?: number | null;
  score: number;
  neededBps: number;
  fits: boolean;
  measured: boolean;
  reasons: string[];
  /** The URL a client would play this source from — a `stingstream.local` mesh URL. */
  streamUrl: string;
}

export interface ItemSourcesResponse {
  itemKey: string;
  policy: string;
  heldLocally: boolean;
  sources: ItemSource[];
}

const field = <T>(raw: unknown, ...names: string[]): T | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) {
      return record[name] as T;
    }
  }
  return undefined;
};

const both = (camel: string): string[] => [
  camel,
  camel.charAt(0).toUpperCase() + camel.slice(1),
];

const toSource = (raw: unknown): ItemSource => ({
  node: field<string>(raw, ...both("node")) ?? "",
  nodeName: field<string>(raw, ...both("nodeName")) ?? "",
  group: field<string>(raw, ...both("group")) ?? "",
  online: field<boolean>(raw, ...both("online")) ?? false,
  resolution: field<string>(raw, ...both("resolution")),
  width: field<number>(raw, ...both("width")),
  height: field<number>(raw, ...both("height")),
  bitrate: field<number>(raw, ...both("bitrate")),
  sizeBytes: field<number>(raw, ...both("sizeBytes")),
  fileHash: field<string>(raw, ...both("fileHash")),
  path: field<string>(raw, ...both("path")),
  rttMs: field<number>(raw, ...both("rttMs"), "RttMs"),
  throughputBps: field<number>(raw, ...both("throughputBps")),
  maxDirectStreams: field<number>(raw, ...both("maxDirectStreams")),
  activeDirectStreams: field<number>(raw, ...both("activeDirectStreams")),
  score: field<number>(raw, ...both("score")) ?? 0,
  neededBps: field<number>(raw, ...both("neededBps")) ?? 0,
  fits: field<boolean>(raw, ...both("fits")) ?? false,
  measured: field<boolean>(raw, ...both("measured")) ?? false,
  reasons: field<string[]>(raw, ...both("reasons")) ?? [],
  streamUrl: field<string>(raw, ...both("streamUrl")) ?? "",
});

const toResponse = (raw: unknown): ItemSourcesResponse => ({
  itemKey: field<string>(raw, ...both("itemKey")) ?? "",
  policy: field<string>(raw, ...both("policy")) ?? "",
  heldLocally: field<boolean>(raw, ...both("heldLocally")) ?? false,
  sources: (field<unknown[]>(raw, ...both("sources")) ?? []).map(toSource),
});

const authHeaders = (
  token: string | null | undefined,
): Record<string, string> =>
  token ? { Authorization: `MediaBrowser Token="${token}"` } : {};

/**
 * `apiBaseUrl` is `StingStream.Core`'s own base, i.e. `getStingStreamApiBaseUrl(api.basePath)` —
 * the same base every other hand-written client in this directory takes, **not** the mesh's
 * `/mesh` sub-path `lib/stingstream/mesh.ts` builds on top of it.
 *
 * Returns `null` on any failure (404 — nothing on this node resolves that id; a node too old to
 * carry the M4 endpoint; the mesh unreachable) rather than throwing, because every caller here has
 * a perfectly good fallback (PlaybackInfo's own MediaSource choice) and a source-selection helper
 * that can throw is a source-selection helper every caller has to wrap in the same try/catch.
 */
export async function fetchItemSources(
  apiBaseUrl: string,
  itemId: string,
  opts: {
    accessToken?: string | null;
    policy?: "speed_first" | "quality_first";
    userId?: string;
    signal?: AbortSignal;
  } = {},
): Promise<ItemSourcesResponse | null> {
  try {
    const params = new URLSearchParams();
    if (opts.policy) params.set("policy", opts.policy);
    if (opts.userId) params.set("userId", opts.userId);
    const qs = params.toString();
    const res = await fetch(
      `${apiBaseUrl}/items/${encodeURIComponent(itemId)}/sources${qs ? `?${qs}` : ""}`,
      { headers: authHeaders(opts.accessToken), signal: opts.signal },
    );
    if (!res.ok) return null;
    return toResponse(await res.json());
  } catch {
    return null;
  }
}

/**
 * The source a download should use: best-scored among the ones actually online, since an offline
 * holder — however it scored before the disqualifier — cannot serve a byte.
 *
 * `null` when the endpoint answered but nothing online holds this title, which is different from
 * "the endpoint failed" (`fetchItemSources` returning `null`) and is handled the same way by every
 * caller: fall back to whatever PlaybackInfo already chose.
 */
export function bestOnlineSource(
  response: ItemSourcesResponse | null,
): ItemSource | null {
  if (!response) return null;
  return response.sources.find((s) => s.online) ?? null;
}
