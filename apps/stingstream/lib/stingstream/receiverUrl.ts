import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import { DEFAULT_LOOKUP_TIMEOUT_MS, withTimeout } from "./castStreamUrl";
import { fetchMeshStatus } from "./meshApi";
import { raceSideDoor, type SideDoorRecord } from "./sidedoor";

/**
 * Make the URLs handed to a cast receiver ones the receiver can actually load.
 *
 * Every URL the app builds starts from `api.basePath`, which is whatever address *this* client
 * reached the node at. Usually that is fine for a receiver too: a phone on the LAN talks to
 * `http://192.168.x.y:8790`, and so can the Chromecast next to it. Two clients reach the node at
 * a loopback address instead, and a receiver is a different device that can never resolve one:
 *
 * - **A browser on the node's own machine**, at `http://127.0.0.1:<port>`. That is also one of the
 *   only two places the Cast Web Sender runs over plain HTTP at all.
 * - **A phone running the embedded mesh**, whose traffic goes through its own `127.0.0.1`
 *   (`docs/APP-MESH.md`).
 *
 * For those, this swaps the loopback origin for the home node's own side door — its HTTPS address,
 * or its plain-HTTP LAN address — found the same way `castStreamUrl.ts` finds a peer's. The path and
 * query are carried over byte for byte, because the query holds the `ApiKey` or the mesh signature
 * the receiver is refused without.
 *
 * When nothing better can be found the URLs come back unchanged, and a receiver that cannot load
 * one fails through `loadMedia`'s own error path, which is where the user already hears about it.
 */

export type ReceiverUrlRewriter = (url: string) => string;

const identity: ReceiverUrlRewriter = (url) => url;

export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "::1" ||
    /^127\./.test(host)
  );
}

/** Everything from the first `/` after the authority, or `""` for a bare origin. */
function pathAndQuery(url: string): string {
  const authorityStart = url.indexOf("//");
  const pathStart = url.indexOf("/", authorityStart + 2);
  return pathStart === -1 ? "" : url.slice(pathStart);
}

export async function createReceiverUrlRewriter(params: {
  jellyfinBasePath: string;
  accessToken?: string | null;
  lookupTimeoutMs?: number;
  raceTimeoutMs?: number;
}): Promise<ReceiverUrlRewriter> {
  // The common case, a client on the LAN or on a real domain, pays for nothing.
  if (!isLoopbackUrl(params.jellyfinBasePath)) return identity;

  const record = await withTimeout<SideDoorRecord | null>(
    fetchMeshStatus(
      getStingStreamApiBaseUrl(params.jellyfinBasePath),
      params.accessToken,
    ).then((status) => status.sideDoor ?? null),
    params.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS,
    null,
  );
  if (!record) return identity;

  const choice = await raceSideDoor(record, {
    timeoutMs: params.raceTimeoutMs,
  }).catch(() => null);
  if (!choice) return identity;

  const origin = choice.url.replace(/\/+$/, "");
  return (url) => (isLoopbackUrl(url) ? `${origin}${pathAndQuery(url)}` : url);
}
