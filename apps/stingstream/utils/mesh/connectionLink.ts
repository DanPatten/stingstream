/**
 * The two links that connect servers, and nothing else.
 *
 * - **An invite link**, made by an administrator of the server it names:
 *   `https://that-server/link#code=…&node=…&server=…`. Whoever opens it on a server they administer
 *   chooses what that server shares and presses Connect, and the connection is complete. A member
 *   who opens it files a request for their administrator instead.
 * - **A start link**, made for a member who is not an administrator here but runs a server of
 *   their own: `https://their-server/link#start=1&return=…&server=…`. On their own server they
 *   choose what it shares, it makes an invite, and the browser comes back here with it.
 *
 * Both ride in the fragment, which a browser never puts on the wire: the code admits a server to a
 * connection, and a query string would write it into every access log on the way.
 *
 * Dan: *"one user does EVERYTHING once and they are done. The other user does everything once and
 * they are done - there isnt any more back and forth."*
 */

/** Where both links land, on whichever server they point at. */
export const LINK_PATH = "/link";

/** What an invite link carries. */
export interface ConnectionInviteLink {
  /** The single-use code. */
  code: string;
  /** Node id of the server that made it, so a page can tell whether it is standing on that server. */
  node: string;
  /** What that server calls itself. */
  server: string;
  /**
   * Set when the link has already been passed from the server that made it to the reader's own.
   * Only matters for a link that carries no node id, which could otherwise bounce for ever.
   */
  forwarded?: boolean;
}

/** What a start link carries. */
export interface ConnectionStartLink {
  /** The origin to send the finished invite back to. */
  returnTo: string;
  /** What that server calls itself. */
  server: string;
}

export type ParsedLink =
  | { kind: "invite"; invite: ConnectionInviteLink }
  | { kind: "start"; start: ConnectionStartLink };

const encodePairs = (pairs: [string, string | undefined][]): string =>
  pairs
    .filter((pair): pair is [string, string] => Boolean(pair[1]))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

const decodePairs = (fragment: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of fragment.replace(/^#/, "").split("&")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    try {
      out[part.slice(0, index)] = decodeURIComponent(part.slice(index + 1));
    } catch {
      // A pair a chat client mangled. The rest of the link may still be whole.
    }
  }
  return out;
};

/** An absolute http(s) origin, or null. */
export const originOf = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
};

/** The invite link for `invite`, on the server at `address`. */
export const buildInviteLink = (
  address: string | null | undefined,
  invite: ConnectionInviteLink,
): string | null => {
  const origin = originOf(address);
  if (!origin || !invite.code?.trim()) return null;
  return `${origin}${LINK_PATH}#${encodePairs([
    ["code", invite.code.trim()],
    ["node", invite.node?.trim() || undefined],
    ["server", invite.server?.trim() || undefined],
    ["fwd", invite.forwarded ? "1" : undefined],
  ])}`;
};

/** The start link that sends a member to their own server, and back here afterwards. */
export const buildStartLink = (
  ownServer: string | null | undefined,
  start: ConnectionStartLink,
): string | null => {
  const origin = originOf(ownServer);
  const back = originOf(start.returnTo);
  if (!origin || !back) return null;
  return `${origin}${LINK_PATH}#${encodePairs([
    ["start", "1"],
    ["return", back],
    ["server", start.server?.trim() || undefined],
  ])}`;
};

/** Read either link back out of a fragment, or null when it is neither. */
export const parseLink = (
  fragment: string | null | undefined,
): ParsedLink | null => {
  if (!fragment) return null;
  const parts = decodePairs(fragment);
  if (parts.start === "1") {
    const returnTo = originOf(parts.return);
    if (!returnTo) return null;
    return { kind: "start", start: { returnTo, server: parts.server ?? "" } };
  }
  if (!parts.code?.trim()) return null;
  return {
    kind: "invite",
    invite: {
      code: parts.code.trim(),
      node: parts.node ?? "",
      server: parts.server ?? "",
      forwarded: parts.fwd === "1" || undefined,
    },
  };
};

/**
 * Whether the page is standing on the server that made this invite.
 *
 * That server cannot use its own invite, so the page there only asks where the reader's server is.
 * A link with no node id is treated as the maker's until it has been forwarded once, which is the
 * only way to avoid sending it round in a circle.
 */
export const isInviteMaker = (
  invite: ConnectionInviteLink,
  thisNode: string | null | undefined,
): boolean => {
  if (!invite.node) return !invite.forwarded;
  return (
    Boolean(thisNode) && invite.node.toLowerCase() === thisNode?.toLowerCase()
  );
};
