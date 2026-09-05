/**
 * Derives a StingStream node's root URL (where the gateway listens, e.g.
 * `http://192.168.1.5:8790`) from the Jellyfin server URL the app is already
 * connected to (e.g. `http://192.168.1.5:8790/jellyfin`).
 *
 * The gateway (`mesh/crates/stingstream`, see docs/RUNNING.md) exposes one
 * port with `/jellyfin/*` routed to the local Jellyfin and
 * `/stingstream/api/v1/*` routed to StingStream.Core. The app's existing
 * Jellyfin connection (`api.basePath` from `@jellyfin/sdk`) is always a
 * StingStream node in this app, so its base path minus a trailing
 * `/jellyfin` segment is the node root — no separate "node URL" setting is
 * needed.
 *
 * A bare Jellyfin URL with no `/jellyfin` suffix (e.g. talking directly to
 * a stock Jellyfin on :8096 during development) is returned unchanged, since
 * there is nothing to strip and no node to reach anyway.
 */
export function getNodeBaseUrl(jellyfinBasePath: string): string {
  const trimmed = jellyfinBasePath.replace(/\/+$/, "");
  return trimmed.replace(/\/jellyfin$/i, "");
}

/** Joins a node base URL with the fixed StingStream API prefix. */
export function getStingStreamApiBaseUrl(jellyfinBasePath: string): string {
  return `${getNodeBaseUrl(jellyfinBasePath)}/stingstream/api/v1`;
}
