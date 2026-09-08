/**
 * Invite links: building one, and reading one somebody pasted.
 *
 * An invite used to be a base58 code you retyped into a form. It is now a link you open, because a
 * link is the thing people already know how to send each other. The code has not changed — the link
 * is the code wrapped in an address a browser can reach.
 *
 * The code rides in the **fragment**, after the `#`, which a browser never puts on the wire. That
 * is not decoration: the code carries the group secret, and a query string would be written into
 * the access log of the server, every proxy in front of it and anything in between. In the fragment
 * it reaches only the page's own JavaScript.
 *
 * The node builds links (`mesh/crates/stingstream-mesh/src/sharing.rs`), so this file does not
 * choose the host. What it does is the half the app is responsible for: turning whatever somebody
 * pasted — a link, a link with a stray space, or the bare code — back into a code to join with.
 */

/** The path an invite link points at, on a node and on the coordinator alike. */
export const JOIN_PATH = "/join";

/**
 * Wrap a code in a host. Mirrors `sharing::invite_link` for the cases the app builds one itself.
 *
 * `null` when there is no host, which is a real answer: a member with no address of their own, in a
 * group with no coordinator, has nowhere to point a link and the UI shows the code instead.
 */
export const buildInviteLink = (
  host: string | null | undefined,
  code: string,
): string | null => {
  const trimmedHost = host?.trim().replace(/\/+$/, "");
  const trimmedCode = code.trim();
  if (!trimmedHost || !trimmedCode) return null;
  return `${trimmedHost}${JOIN_PATH}#${trimmedCode}`;
};

/**
 * Read an invite out of whatever was pasted, scanned or typed.
 *
 * Accepts, in this order:
 *
 * - **A link** — `https://media.example.com/join#CODE`, or the `stingstream://join#CODE` deep link.
 *   Everything before the `#` is thrown away, because the host was only ever how the page was
 *   reached; the code is what joins.
 * - **A bare code** — what every invite before this change was, and what a member with no host
 *   still hands out. It passes through untouched.
 *
 * Returns `null` for anything else, and specifically for **a link with no fragment**. That case is
 * worth refusing rather than guessing at: `https://media.example.com/join` is what a link looks
 * like after a chat app has helpfully stripped the fragment, or after somebody copied the address
 * bar of a page that had already consumed it. Treating the URL itself as a code would send a
 * meaningless string to the node and surface as "invite code is not valid base58check", which
 * describes the symptom and not the cause.
 */
export const parseInviteInput = (input: string): string | null => {
  const raw = input.trim();
  if (!raw) return null;

  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!looksLikeUrl) {
    // A bare code. base58 has no `#`, `/` or whitespace in it, so anything carrying one is a
    // mangled link rather than a code, and saying so beats a decode error from the node.
    return /[\s#/?]/.test(raw) ? null : raw;
  }

  const hash = raw.indexOf("#");
  if (hash === -1) return null;
  const code = raw.slice(hash + 1).trim();
  return code.length > 0 ? code : null;
};

/**
 * The code in the address of the page being viewed, on web.
 *
 * `null` everywhere else and whenever there is no fragment, so a caller can use it unconditionally.
 * Reading `location` directly rather than through a router hook is deliberate: the fragment is not
 * part of a route, no navigator reports it, and it has to be read before anything re-navigates.
 */
export const inviteCodeFromLocation = (): string | null => {
  if (typeof window === "undefined") return null;
  const hash = window.location?.hash ?? "";
  const code = hash.startsWith("#") ? hash.slice(1).trim() : "";
  return code.length > 0 ? decodeURIComponent(code) : null;
};
