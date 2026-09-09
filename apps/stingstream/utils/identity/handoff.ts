/**
 * The hand-off between two servers when somebody signs in with their own.
 *
 * Two hops, and both of them carry what they carry in the URL **fragment**:
 *
 * 1. The server being signed in to sends the browser to the person's *own* server:
 *    `https://my-server/authorize#aud=…&nonce=…&return=…`
 * 2. Their own server, once it has signed the statement, sends them back:
 *    `https://their-server/join#assertion=…`
 *
 * ## Why a redirect and not a cross-origin call
 *
 * The alternative is for the page on server A to POST the password straight to server B. That
 * means B accepting credentialed cross-origin requests from any origin, and it means somebody
 * typing their password into a page that somebody else's server served. The redirect keeps the
 * password on its own origin, where it belongs, and it is what Dan described: *"they can do that
 * later in settings pretty easily by entering the URL of their instance and then going to an auth
 * flow"*.
 *
 * ## Why the fragment
 *
 * A browser never puts a fragment on the wire. The nonce is not a credential, but the assertion
 * coming back *is* — it signs its holder in — and a query string would write it into the access
 * log of the server, every proxy in front of it, and anything in between. Same reasoning, and the
 * same mechanism, as `utils/mesh/inviteLink.ts` and the person-invite link.
 *
 * ## Why not base64
 *
 * `toBase64Url` in `lib/stingstream/webauthn.ts` is built on `btoa`, which is a browser API — and
 * this runs on a phone too. Percent-encoded pairs need no polyfill, survive being pasted, and are
 * legible in a bug report.
 */

/** Where `/authorize` lives, on whichever server is being asked to vouch. */
export const AUTHORIZE_PATH = "/authorize";

/** What the signing server is being asked for. */
export interface AuthorizeRequest {
  /** Node id of the server that wants the assertion. */
  audience: string;
  /** Its challenge. */
  nonce: string;
  /** Where to send the browser back to, once it is signed. */
  returnTo: string;
  /** What that server calls itself, so the consent screen can name it. */
  serverName?: string;
  /**
   * An invite token to carry back with the assertion.
   *
   * Round-tripped rather than held: the page that started this is replaced by a navigation to
   * another origin, so anything it was holding is gone by the time the answer arrives. It is a
   * credential, which is why every hop of this is in a fragment.
   */
  invite?: string;
  /**
   * Whether they also asked for the two servers to be linked.
   *
   * Round-tripped for the same reason the invite is: the page that asked is replaced by a
   * navigation to another origin, so nothing it was holding survives to the answer.
   */
  link?: boolean;
}

const encodePairs = (pairs: [string, string | undefined][]): string =>
  pairs
    .filter((pair): pair is [string, string] => Boolean(pair[1]))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

const decodePairs = (fragment: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of fragment.replace(/^#/, "").split("&")) {
    if (!part) continue;
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index);
    try {
      out[key] = decodeURIComponent(part.slice(index + 1));
    } catch {
      // A fragment somebody hand-edited, or one a chat client mangled. Drop the pair rather than
      // throwing: the caller's "this link is incomplete" is a better answer than a crash.
    }
  }
  return out;
};

/** Build the link that sends somebody to their own server to be vouched for. */
export const buildAuthorizeUrl = (
  homeOrigin: string,
  request: AuthorizeRequest,
): string | null => {
  const origin = homeOrigin?.trim().replace(/\/+$/, "");
  if (!origin || !request?.audience?.trim() || !request?.nonce?.trim()) {
    return null;
  }

  const fragment = encodePairs([
    ["aud", request.audience.trim()],
    ["nonce", request.nonce.trim()],
    ["return", request.returnTo],
    ["server", request.serverName],
    ["invite", request.invite],
    ["link", request.link ? "1" : undefined],
  ]);

  return `${origin}${AUTHORIZE_PATH}#${fragment}`;
};

/** Read what this server is being asked to vouch for, out of the fragment. */
export const parseAuthorizeRequest = (
  fragment: string | null | undefined,
): AuthorizeRequest | null => {
  if (!fragment) return null;
  const parts = decodePairs(fragment);
  // Both are required and neither can be guessed at: without an audience the assertion would be
  // usable at every server, and without a nonce it would be usable twice.
  if (!parts.aud || !parts.nonce) return null;

  return {
    audience: parts.aud,
    nonce: parts.nonce,
    returnTo: parts.return ?? "",
    serverName: parts.server || undefined,
    invite: parts.invite || undefined,
    link: parts.link === "1" || undefined,
  };
};

/**
 * Build the link that sends somebody back, with the signed assertion.
 *
 * `link` comes back as well as going out: the page that asked the question was replaced by a
 * navigation to another origin, so the answer has to be carried rather than remembered.
 */
export const buildReturnUrl = (
  returnTo: string,
  assertion: string,
  link?: boolean,
): string | null => {
  const target = returnTo?.trim();
  if (!target || !assertion?.trim()) return null;
  // Anything already in the fragment belongs to the page that sent us here and has been consumed;
  // replacing it is what keeps a stale nonce from being read back as a fresh one.
  const base = target.split("#")[0];
  return `${base}#${encodePairs([
    ["assertion", assertion.trim()],
    ["link", link ? "1" : undefined],
  ])}`;
};

/** Read a signed assertion out of a fragment. */
export const parseAssertion = (
  fragment: string | null | undefined,
): string | null => {
  if (!fragment) return null;
  const parts = decodePairs(fragment);
  return parts.assertion || null;
};

/** Whether the assertion coming back also asked for the two servers to be linked. */
export const parseReturnLink = (
  fragment: string | null | undefined,
): boolean => {
  if (!fragment) return false;
  return decodePairs(fragment).link === "1";
};

/**
 * The fragment of the page as it is right now, or null off the web.
 *
 * Read during render rather than in an effect, the way `inviteCodeFromLocation` is: an effect runs
 * after the router has had a chance to navigate, and the fragment is gone by then.
 */
export const fragmentFromLocation = (): string | null => {
  if (typeof globalThis === "undefined") return null;
  const location = (globalThis as { location?: { hash?: string } }).location;
  const hash = location?.hash;
  return hash && hash.length > 1 ? hash : null;
};

/** This page's own URL with the fragment removed — where to be sent back to. */
export const returnTargetFromLocation = (): string | null => {
  if (typeof globalThis === "undefined") return null;
  const location = (globalThis as { location?: { href?: string } }).location;
  const href = location?.href;
  return href ? href.split("#")[0] : null;
};
