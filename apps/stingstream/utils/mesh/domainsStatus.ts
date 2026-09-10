import type { MeshDomainsStatus } from "@/lib/stingstream/meshApi";

/**
 * The one line at the top of the Domains page, decided outside React.
 *
 * ## What this replaced
 *
 * Six "states", each with a title and a sentence — *"No address yet"* over a server that plainly
 * had a LAN address, *"Address set"*, *"Serving HTTPS itself"*. Dan: *"section is overly
 * complicated and verbose.. you are either LAN or public if set show the address at the top - no
 * address yet isnt true since you have LAN"*.
 *
 * Both halves of that are right, and the second is the sharper one: a server is **always**
 * reachable somewhere. There is no such thing as no address — there is an address that only works
 * on this network, and an address that works anywhere. So this answers *which of those two*, and
 * hands back the address itself rather than a label describing one.
 *
 * `starting` and `error` are not a third and fourth kind of reach; they are the two moments when
 * the answer is changing and the page has to say so.
 *
 * Kept out of the component for the reason `sharingAddress.ts` is: `bun:test` can load a module
 * that imports nothing from React, and a page that says "Public" over a dead tunnel looks exactly
 * like one that is right.
 */
export type DomainsReach = "public" | "lan" | "starting" | "error";

export interface DomainsSummary {
  reach: DomainsReach;
  /**
   * The address to show, verbatim. `null` only on a server that has not reported a LAN address
   * either — the first render, and nothing else.
   */
  address: string | null;
  /** The node's own words, for `error` alone. Never translated: it is data. */
  detail: string | null;
}

/**
 * Which address is the one to show, and whether the world can use it.
 *
 * The order is the whole of the logic, and two parts of it are deliberate:
 *
 * - **A broken tunnel outranks everything**, including a perfectly good certificate. Both can be
 *   true at once, and the broken one is the thing somebody just pressed a button to create.
 * - **A public address is reported without being verified.** This server cannot see the other end
 *   of its own domain, and an address with no TLS *on the node* is exactly what a working
 *   Cloudflare Tunnel, Caddy or nginx looks like from in here. Calling that broken would be wrong
 *   for most of the people who ever set the field by hand.
 */
export function domainsSummary(
  status: MeshDomainsStatus | undefined,
): DomainsSummary {
  const lan = status?.lanUrls?.[0] ?? null;
  if (!status) return { reach: "lan", address: lan, detail: null };

  const { tunnel } = status;

  if (tunnel.state === "error")
    return {
      reach: "error",
      // The address it was trying to reach, so the error names the thing it is about.
      address: tunnel.hostname ?? status.publicAddress ?? lan,
      detail: tunnel.detail,
    };

  if (tunnel.state === "starting")
    return {
      reach: "starting",
      address: tunnel.hostname ?? status.publicAddress ?? lan,
      detail: null,
    };

  if (status.publicAddress)
    return { reach: "public", address: status.publicAddress, detail: null };

  return { reach: "lan", address: lan, detail: null };
}

/** Whether a tunnel is configured, so the thing to offer is "stop it" rather than "set one up". */
export const hasTunnel = (status: MeshDomainsStatus | undefined): boolean =>
  !!status && status.tunnel.kind !== "none";

/**
 * `media.example.com` from anything somebody might type or paste.
 *
 * The setup flow needs a bare hostname for the DNS record, and the field beside it accepts an
 * origin because that is what the address setting stores. Taking a URL apart here means neither
 * has to ask the reader to edit a scheme off by hand.
 */
export const bareHostname = (input: string): string => {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).hostname;
  } catch {
    return trimmed;
  }
};
