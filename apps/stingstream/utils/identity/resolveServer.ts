import { probeCandidate } from "@/lib/stingstream/sidedoor";

/**
 * Turn what somebody typed into the origin of a StingStream node, or null.
 *
 * Two screens ask this question and they have to agree on the answer: signing in with your own
 * server from `/join`, and adding a server from Settings. Both are the same act seen from
 * different ends, and a second copy of this would be a second set of rules about which addresses
 * work.
 *
 * **`/sidedoor/v1/hello`, not `/System/Info/Public`.** The probe is cross-origin by construction:
 * the page was served by one node and is asking about another, and a node answers no other route
 * to another origin. `checkJellyfinServer` was used here first and could never have worked outside
 * a test where both were the same host, because the browser blocked it on CORS before the other
 * node ever saw it. The side door exists for exactly this question (`docs/SIDEDOOR.md` §4).
 *
 * HTTPS first, then plain HTTP, unless they typed a scheme themselves. A bare `host:port` on a LAN
 * is the common case and is almost never HTTPS; a domain almost always is.
 */
export const resolveServerOrigin = async (
  typed: string,
): Promise<string | null> => {
  const bare = typed.trim().replace(/\/+$/, "");
  if (!bare) return null;

  const candidates = /^https?:\/\//i.test(bare)
    ? [bare]
    : [`https://${bare}`, `http://${bare}`];

  for (const url of candidates) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    // No expected node id: nobody has told us which node lives there, and the answer is what
    // tells us it is a node at all.
    const outcome = await probeCandidate(
      {
        kind: "own",
        host: parsed.hostname,
        port: Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80),
        url,
      },
      "",
    );
    if (outcome.ok) return url;
  }
  return null;
};
