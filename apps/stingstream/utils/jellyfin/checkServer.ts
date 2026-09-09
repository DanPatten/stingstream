import type { PublicSystemInfo } from "@jellyfin/sdk/lib/generated-client";
import { writeInfoLog, writeToLog } from "@/utils/log";

/** Thrown when the server answered but is older than Streamyfin supports. */
export class ServerTooOldError extends Error {
  constructor() {
    super("Server too old");
    this.name = "ServerTooOldError";
  }
}

/**
 * Thrown when something is listening and answering, but it is not Jellyfin - and it is not
 * Jellyfin under `/jellyfin` either.
 *
 * Worth its own type because the honest message is not "could not connect": something *did*
 * connect. A StingStream node is the case that made this necessary. Its gateway serves Jellyfin
 * under `/jellyfin` and answers every path it does not know with its own placeholder page at HTTP
 * 200, so typing the node's own address got HTML where the check wanted JSON, and the user was
 * told to check their network connection for what was a path problem.
 */
export class NotAJellyfinServerError extends Error {
  constructor() {
    // Never shown to the user directly — LoginScreen.tsx catches this by `instanceof` and
    // displays login.not_a_jellyfin_server_description instead. Worded the same way regardless,
    // so a stack trace or Sentry report reads the same as what the user saw.
    super(
      "That address answered, but it is not a StingStream server. Check the address and try again.",
    );
    this.name = "NotAJellyfinServerError";
  }
}

/**
 * Thrown when a StingStream node answered, and answered honestly: it is still coming up.
 *
 * Worth its own type because it is the one failure that is not about the address. A node's
 * gateway starts listening seconds before the Jellyfin behind it is routable, and until it is,
 * every request through it gets `503` + `Retry-After` (`gateway/mod.rs`). Reported as
 * "that is not a StingStream server" it sends somebody to check an address that was right all
 * along — which is exactly what happened on a cold node, and is what put the address form in
 * front of Dan on a page his own node had served.
 *
 * A caller that can wait should wait. `LoginScreen`'s auto-connect does.
 */
export class ServerStartingError extends Error {
  constructor() {
    super("That server is still starting up.");
    this.name = "ServerStartingError";
  }
}

/** Where a StingStream node's gateway puts Jellyfin. */
export const JELLYFIN_SUBPATH = "jellyfin";

export interface CheckedServer {
  /** The URL that answered, including the protocol that worked. */
  url: string;
  name: string;
}

/** LAN probes either answer near-instantly or never; don't let one candidate
 * hang the whole check. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Statuses that mean "there, but not ready yet".
 *
 * 503 is the node's own gateway refusing to route to a child that is starting or backing off.
 * 502 and 504 are what a reverse proxy in front of one says about the same state, and a node
 * behind Cloudflare Tunnel or Caddy is a documented setup (`docs/SIDEDOOR.md`).
 */
const STARTING_STATUSES = new Set([502, 503, 504]);

/** Streamyfin needs 10.10 or newer. Anything unparseable is given the benefit
 * of the doubt — a server that answers but reports an odd version string must
 * not be locked out. */
function isSupportedVersion(version?: string | null): boolean {
  const [major, minor] = (version ?? "").split(".").map(Number);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return true;
  return major > 10 || (major === 10 && minor >= 10);
}

/**
 * Probes a user-entered address for a Jellyfin server and returns the URL
 * that answered. An explicitly typed scheme is trusted as-is — a typed
 * `http://` is never upgraded and a typed `https://` never silently
 * downgraded; only schemeless input probes https first, http as fallback.
 *
 * @throws ServerTooOldError when the server is reachable but unsupported.
 * @throws ServerStartingError when a node answered and is still coming up.
 */
export async function checkJellyfinServer(
  input: string,
  probeTimeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<CheckedServer | undefined> {
  const trimmed = input.trim();
  const typedScheme = /^(https?):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
  const host = trimmed.replace(/^https?:\/\//i, "");
  const protocols = typedScheme ? [typedScheme] : ["https", "http"];
  writeInfoLog(
    `Server check: input "${input}" -> probing host "${host}" via ${protocols.join(", ")}`,
  );

  // Set when something answered but was not Jellyfin, at the root *and* under /jellyfin. That is
  // a different failure from "nothing answered", and it gets a different message; see
  // NotAJellyfinServerError.
  let answeredButNotJellyfin = false;
  // Set when a node said, in as many words, that it is not ready yet. See ServerStartingError.
  let starting = false;

  for (const protocol of protocols) {
    const url = `${protocol}://${host}`;
    const root = await probePublicInfo(url, probeTimeoutMs);
    if (root.kind === "ok") return adopt(url, root.data);

    // Nothing answered: wrong address, nothing listening, or an https probe against a plain-HTTP
    // port. There is no point asking that same nothing about a sub-path, and doing so would double
    // how long a genuinely unreachable address takes to give up.
    if (root.kind === "miss") continue;

    // Still coming up. Asking the same gateway about a sub-path gets the same 503 from the same
    // unrouted child, so there is nothing to learn from a second request.
    if (root.kind === "starting") {
      starting = true;
      continue;
    }

    // Something answered, and it was not Jellyfin. On a StingStream node it will not be: the
    // gateway serves Jellyfin under /jellyfin and answers the root itself — with its placeholder
    // page on an older node, and with a 404 naming the right base on a newer one. **Both have to
    // lead here**, which is why this turns on "answered at all" rather than on the HTML: the
    // gateway's own fix would otherwise have quietly undone this one.
    answeredButNotJellyfin = true;
    if (alreadyNested(host)) continue;

    const nested = `${url}/${JELLYFIN_SUBPATH}`;
    writeInfoLog(
      `Server check: ${url} answered, but it is not Jellyfin; trying ${nested}`,
    );
    const under = await probePublicInfo(nested, probeTimeoutMs);
    if (under.kind === "ok") return adopt(nested, under.data);
    if (under.kind === "starting") starting = true;
  }

  // Ordered: "it is starting" is both more specific and more actionable than "it is not a
  // StingStream server", and a gateway that is starting satisfies both descriptions.
  if (starting) throw new ServerStartingError();
  if (answeredButNotJellyfin) throw new NotAJellyfinServerError();

  // Environmental (wrong address, server down), not an app defect — local
  // log only.
  writeToLog("WARN", `Server check: no protocol worked for "${host}"`);
  return undefined;
}

/** Whether the address already names the sub-path, so it is not looked for twice. */
function alreadyNested(host: string): boolean {
  return host
    .replace(/\/+$/, "")
    .toLowerCase()
    .endsWith(`/${JELLYFIN_SUBPATH}`);
}

/** What one `/System/Info/Public` request came back as. */
type Probe =
  | { kind: "ok"; data: PublicSystemInfo }
  /**
   * An HTTP response came back, but it is not a Jellyfin document: a non-2xx, or a 2xx whose body
   * is HTML or otherwise not an object. Something is listening, and it is worth asking it about
   * `/jellyfin`.
   */
  | { kind: "answered" }
  /**
   * A node's gateway is there and says it is not ready: 503 while a child is still starting or in
   * its restart backoff, or a 502/504 from a reverse proxy in front of one. Distinct from
   * `answered` because the address is right and waiting is the correct response.
   */
  | { kind: "starting" }
  /** Nothing answered: refused, timed out, DNS, or a failed TLS handshake. */
  | { kind: "miss" };

/**
 * Ask one base URL whether it is a Jellyfin server.
 *
 * @param url The base to probe, without a trailing slash.
 * @param probeTimeoutMs How long to wait before giving up on this one.
 * @returns What came back.
 * @throws ServerTooOldError When it is Jellyfin, but older than Streamyfin supports.
 */
async function probePublicInfo(
  url: string,
  probeTimeoutMs: number,
): Promise<Probe> {
  // A dead HTTPS port on a LAN IP can leave the connection hanging instead
  // of refusing it, which would block the http fallback forever.
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), probeTimeoutMs);
  try {
    const response = await fetch(`${url}/System/Info/Public`, {
      mode: "cors",
      signal: abort.signal,
    });
    if (!response.ok) {
      // WARN, not ERROR: probe failures are routine (http probe against an
      // https-only server, typos, offline) and must not become Sentry
      // events — they stay in the local log and breadcrumb trail.
      writeToLog(
        "WARN",
        `Server check: ${url} answered HTTP ${response.status}`,
      );
      return STARTING_STATUSES.has(response.status)
        ? { kind: "starting" }
        : { kind: "answered" };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      writeToLog(
        "WARN",
        `Server check: ${url} answered 200 with a body that is not JSON`,
      );
      return { kind: "answered" };
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      writeToLog(
        "WARN",
        `Server check: ${url} answered 200 with JSON that is not a Jellyfin document`,
      );
      return { kind: "answered" };
    }

    const data = body as PublicSystemInfo;
    if (!isSupportedVersion(data.Version)) throw new ServerTooOldError();
    return { kind: "ok", data };
  } catch (e) {
    if (e instanceof ServerTooOldError) throw e;
    writeToLog(
      "WARN",
      `Server check: ${url} failed — ${
        abort.signal.aborted
          ? `timed out after ${probeTimeoutMs}ms`
          : e instanceof Error
            ? `${e.name}: ${e.message}`
            : String(e)
      }`,
    );
    return { kind: "miss" };
  } finally {
    clearTimeout(timeout);
  }
}

/** Accept a base that answered. */
function adopt(url: string, data: PublicSystemInfo): CheckedServer {
  writeInfoLog(
    `Server check: ${url} OK — "${data.ServerName}" v${data.Version}`,
  );
  return { url, name: data.ServerName || "" };
}
