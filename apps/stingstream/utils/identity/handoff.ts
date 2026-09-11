/**
 * The hand-off between two servers when somebody signs in with their own.
 *
 * Two hops, and both of them carry what they carry in the URL **fragment**:
 *
 * 1. The server being signed in to sends the browser to the person's *own* server:
 *    `https://my-server/authorize#aud=…&nonce=…&return=…`
 * 2. Their own server, once it has signed the statement, sends them back:
 *    `https://their-server/join#assertion=…&salt=…&verifier=…&kdf=…`
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
 * It is also what makes the second hop safe to carry a credential at all. What comes back is not
 * the password but a PBKDF2 of it, derived on the origin the password was typed on and usable only
 * on the server that asked — Dan: *"without the OTHER server knowing what that user's password is
 * but it still can validate it"*.
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

/**
 * The query parameter that carries the other server's address home again.
 *
 * The page that asks is replaced by a navigation to another origin, so nothing it was holding
 * survives to the answer. The assertion and the invite ride back in the fragment for that reason;
 * an address is not a credential, so it rides in the query string, where it also survives a
 * reload of the page that lands on it.
 *
 * Both doors set it -- `/join`'s "I already run StingStream" and Settings' *Add server* -- because
 * both end in the same place: a request whose approval should hand back a link to open rather than
 * a code to paste.
 */
export const LINK_TO_PARAM = "link_to";

/** Add the resolved address to a return target, so it comes back with the answer. */
export const withLinkTo = (returnTo: string, origin: string): string => {
  const target = returnTo?.trim();
  if (!target || !origin?.trim()) return target ?? "";
  const separator = target.includes("?") ? "&" : "?";
  return `${target}${separator}${LINK_TO_PARAM}=${encodeURIComponent(origin.trim())}`;
};

/** Read it back off the page that was returned to, or null. */
export const linkToFromLocation = (): string | null => {
  if (typeof globalThis === "undefined") return null;
  const search = (globalThis as { location?: { search?: string } }).location
    ?.search;
  try {
    return new URLSearchParams(search ?? "").get(LINK_TO_PARAM);
  } catch {
    // A query string somebody hand-edited. The assertion still names the node, so the offer is
    // recorded without an address and the screen shows the code instead of a link.
    return null;
  }
};

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
 * What comes back with the assertion so the other server can check this person's password later.
 *
 * Derived on the page that asked for it, from a password typed on its own origin — the other server
 * is handed the result and never the password. `utils/identity/verifier.ts` has the shape of it.
 */
export interface ReturnCredential {
  /** The salt the verifier was derived with, for that server to keep. */
  salt: string;
  /** PBKDF2 of their password, which becomes their password on the server they are joining. */
  verifier: string;
  /** How many rounds produced it, so a future change to the default cannot lock anybody out. */
  iterations: number;
}

/**
 * Build the link that sends somebody back, with the signed assertion.
 *
 * `link` comes back as well as going out: the page that asked the question was replaced by a
 * navigation to another origin, so the answer has to be carried rather than remembered. The
 * credential rides the same way and for the same reason, and is the one thing here that does not
 * expire — which is why the page that reads it drops it out of the address bar straight away.
 */
export const buildReturnUrl = (
  returnTo: string,
  assertion: string,
  extras: {
    /** Whether they also asked for the two servers to be linked. */
    link?: boolean;
    /**
     * The invite that started this, handed straight back.
     *
     * **Without this the first sign-in can never succeed.** A genuine assertion from a server the
     * target has never heard of proves who somebody is and grants nothing — `IdentityGate`
     * requires a live invite the first time — and the page holding that invite was replaced by a
     * navigation to another origin, so nothing on the far side remembers it. It goes out in the
     * request and has to come back in the answer.
     */
    invite?: string;
    /** The salt and derived password, so this person can sign in here without their server. */
    credential?: ReturnCredential;
  } = {},
): string | null => {
  const target = returnTo?.trim();
  if (!target || !assertion?.trim()) return null;
  // Anything already in the fragment belongs to the page that sent us here and has been consumed;
  // replacing it is what keeps a stale nonce from being read back as a fresh one.
  const base = target.split("#")[0];
  // All three or none: a salt without a verifier is a password nobody can reproduce, and a verifier
  // without its round count cannot be checked again after the default moves. Read out first rather
  // than tested in place, so what is sent is exactly what was checked.
  const salt = extras.credential?.salt.trim() ?? "";
  const verifier = extras.credential?.verifier.trim() ?? "";
  const rounds = extras.credential?.iterations ?? 0;
  const complete =
    salt.length > 0 &&
    verifier.length > 0 &&
    Number.isInteger(rounds) &&
    rounds > 0;
  return `${base}#${encodePairs([
    ["assertion", assertion.trim()],
    ["link", extras.link ? "1" : undefined],
    ["invite", extras.invite?.trim() || undefined],
    ["salt", complete ? salt : undefined],
    ["verifier", complete ? verifier : undefined],
    ["kdf", complete ? String(rounds) : undefined],
  ])}`;
};

/** Read the invite token back out of the return fragment. */
export const parseReturnInvite = (
  fragment: string | null | undefined,
): string | null => {
  if (!fragment) return null;
  return decodePairs(fragment).invite || null;
};

/** Read a signed assertion out of a fragment. */
export const parseAssertion = (
  fragment: string | null | undefined,
): string | null => {
  if (!fragment) return null;
  const parts = decodePairs(fragment);
  return parts.assertion || null;
};

/**
 * Read the password credential out of a fragment, or null when it carries none.
 *
 * Null rather than a partial: an older client's return leg has no credential at all, and the server
 * still knows what to do with that — the account keeps a password nobody knows, exactly as before.
 */
export const parseReturnCredential = (
  fragment: string | null | undefined,
): ReturnCredential | null => {
  if (!fragment) return null;
  const parts = decodePairs(fragment);
  const iterations = Number.parseInt(parts.kdf ?? "", 10);
  if (
    !parts.salt ||
    !parts.verifier ||
    !Number.isInteger(iterations) ||
    iterations < 1
  ) {
    return null;
  }
  return { salt: parts.salt, verifier: parts.verifier, iterations };
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

/**
 * Drop the fragment out of the address bar, keeping the page where it is.
 *
 * The return leg carries a credential that does not expire — it becomes this person's password on
 * this server — so unlike the assertion beside it, leaving it in the browser's history would be
 * leaving a credential lying about. Called before the sign-in rather than after: a failed one is
 * exactly when somebody goes back through their history.
 *
 * A no-op off the web, where there is no address bar and nothing kept one.
 */
export const clearFragment = (): void => {
  const scope = globalThis as {
    history?: { replaceState?: (a: unknown, b: string, c: string) => void };
    location?: { pathname?: string; search?: string };
  };
  const here = `${scope.location?.pathname ?? ""}${scope.location?.search ?? ""}`;
  if (!here) return;
  scope.history?.replaceState?.(null, "", here);
};

/** This page's own URL with the fragment removed — where to be sent back to. */
export const returnTargetFromLocation = (): string | null => {
  if (typeof globalThis === "undefined") return null;
  const location = (globalThis as { location?: { href?: string } }).location;
  const href = location?.href;
  return href ? href.split("#")[0] : null;
};
