/**
 * A LAN Jellyfin discovery broadcast answers with whatever port the embedded
 * Jellyfin is actually listening on -- not the StingStream gateway's port
 * (8790) that sits in front of it and is what the app should actually talk
 * to. Expanding a discovery hit into probe candidates -- the node's own
 * gateway first, the address discovery literally reported second -- lets
 * `checkJellyfinServer` land on the gateway when the node answers there, and
 * still fall back to the discovered address for a bare Jellyfin (or any
 * server where the gateway is not on the default port).
 */

/** The StingStream gateway's default port. */
const NODE_GATEWAY_PORT = 8790;

/**
 * Expand one discovered server address into the base URLs worth probing, in
 * probe order. Always returns at least the input address; an address with no
 * parseable host is returned unchanged as the only candidate.
 */
export function nodeCandidates(discoveredAddress: string): string[] {
  const host = /^https?:\/\/([^/:?#]+)(?::\d+)?/i.exec(discoveredAddress)?.[1];
  if (!host) return [discoveredAddress];

  const gatewayUrl = `http://${host}:${NODE_GATEWAY_PORT}`;
  return gatewayUrl === discoveredAddress
    ? [gatewayUrl]
    : [gatewayUrl, discoveredAddress];
}
