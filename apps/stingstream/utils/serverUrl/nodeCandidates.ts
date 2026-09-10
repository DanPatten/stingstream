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

import { NODE_GATEWAY_PORT } from "@/constants/Networking";

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

/**
 * Expand an address somebody **typed** into the bases worth probing, in probe order.
 *
 * `checkJellyfinServer` already forgives two of the three things people get wrong: a missing
 * scheme (it probes https then http) and a missing `/jellyfin` (it retries under the sub-path when
 * something answers that is not Jellyfin). The third is the port, and it is the one that fails
 * silently — `192.168.0.16` probes port 80, finds nothing, and reports "could not connect" about a
 * server that is running perfectly well on 8790.
 *
 * Home Assistant simply assumes its own port when you type a bare host, which is the behaviour
 * worth copying. So does this, with one refinement: the gateway port goes **first** only for an
 * address that looks like it is on a home network. A real domain name is far more likely to be a
 * tunnel or a reverse proxy on 443, and probing 8790 there first would spend a timeout to learn
 * nothing.
 *
 * An address that already names a port, or carries a path, is trusted exactly as typed.
 */
export function typedAddressCandidates(input: string): string[] {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return [];

  const scheme = /^https?:\/\//i.exec(trimmed)?.[0] ?? "";
  const rest = trimmed.slice(scheme.length);
  const [authority, ...pathParts] = rest.split("/");

  // Trust a typed port, and trust a typed path: both are somebody being specific.
  const hasPort = /:\d+$/.test(authority) || /^\[[^\]]+\]:\d+$/.test(authority);
  if (hasPort || pathParts.length > 0) return [trimmed];
  // An IPv6 literal with no port is unusual enough to leave alone rather than guess at.
  if (authority.startsWith("[")) return [trimmed];

  const withPort = `${scheme}${authority}:${NODE_GATEWAY_PORT}`;
  return looksLocal(authority) ? [withPort, trimmed] : [trimmed, withPort];
}

/**
 * Whether a host is the kind of thing found on a home network: an IPv4 literal, a `.local` name,
 * or a single label with no dots at all (`attic`, resolved by NetBIOS or a router's own DNS).
 */
function looksLocal(host: string): boolean {
  const name = host.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  if (name.endsWith(".local")) return true;
  return !name.includes(".");
}
