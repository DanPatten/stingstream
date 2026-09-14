/**
 * Turn what somebody typed into the origin of the server they mean, or null.
 *
 * Three screens ask this question and they have to agree on the answer: signing in with your own
 * server, adding a server from Settings, and an invite link opened on the server that made it. All
 * of them then send the browser to that origin, and the page there does the rest.
 *
 * **Worked out from the text, never by asking the address.** This used to probe
 * `/sidedoor/v1/hello` before navigating. On a page served from a public domain, a fetch to a home
 * or LAN address (`127.0.0.1`, `192.168.x.x`) is exactly what Chrome's local network access check
 * stops to ask permission for, so everybody who typed their own server saw a browser prompt and,
 * while it was open, a "not found" error. A navigation is not subject to that check. Dan: *"anything
 * to reduce friction here"*. What is lost is an inline error for a typo; the browser's own "can't
 * reach this site" page says the same thing.
 *
 * **The scheme, when they did not type one**, follows what the address looks like: a name on a
 * home network (`localhost`, an IP, a single word, `.local`, `.lan`, `.home.arpa`) is plain HTTP,
 * because that is what a node serves there; anything else is a domain, and a domain is HTTPS.
 */
export const resolveServerOrigin = async (
  typed: string,
): Promise<string | null> => serverOriginFromInput(typed);

export const serverOriginFromInput = (typed: string): string | null => {
  const bare = typed.trim();
  if (!bare || /\s/.test(bare)) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(bare);
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? bare : `http://${bare}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;

  if (!hasScheme && !isHomeNetworkHost(parsed.hostname)) {
    parsed.protocol = "https:";
  }
  return parsed.origin;
};

const HOME_SUFFIXES = [".local", ".lan", ".home", ".internal", ".home.arpa"];

/** A host that only means something on the reader's own network. */
export const isHomeNetworkHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(":")) return true; // IPv6
  if (!host.includes(".")) return true;
  return HOME_SUFFIXES.some((suffix) => host.endsWith(suffix));
};
