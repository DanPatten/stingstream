import type { PublicSystemInfo } from "@jellyfin/sdk/lib/generated-client";
import {
  type CustomHeader,
  normalizeCustomHeaders,
  optionsWithOptionalHeaders,
} from "@/utils/customHeaders";
import { writeInfoLog, writeToLog } from "@/utils/log";
import {
  getServerCustomHeaders,
  updateServerCustomHeaders,
} from "@/utils/secureCredentials";

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
    super(
      "That address answered, but it is not a Jellyfin server. StingStream nodes serve Jellyfin " +
        "under /jellyfin - try adding it to the address.",
    );
    this.name = "NotAJellyfinServerError";
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
 * Custom proxy headers are attached so a server behind Cloudflare Access (or a
 * similar gateway) can be reached at all. Passing `customHeaders` — even as an
 * empty list — means "these are the headers the user just entered": they
 * replace whatever is saved and are persisted once the server answers. Omit it
 * to reuse the headers already stored for the server.
 *
 * @throws ServerTooOldError when the server is reachable but unsupported.
 */
export async function checkJellyfinServer(
  input: string,
  customHeaders?: CustomHeader[],
  probeTimeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<CheckedServer | undefined> {
  const trimmed = input.trim();
  const typedScheme = /^(https?):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
  const host = trimmed.replace(/^https?:\/\//i, "");
  const protocols = typedScheme ? [typedScheme] : ["https", "http"];
  writeInfoLog(
    `Server check: input "${input}" -> probing host "${host}" via ${protocols.join(
      ", ",
    )} (custom headers: ${
      customHeaders === undefined ? "saved" : customHeaders.length
    })`,
  );

  // Set when something answered 2xx with a body that was not a Jellyfin document, at the root
  // *and* under /jellyfin. That is a different failure from "nothing answered", and it gets a
  // different message; see NotAJellyfinServerError.
  let answeredButNotJellyfin = false;

  for (const protocol of protocols) {
    const url = `${protocol}://${host}`;
    const probe = await probePublicInfo(url, customHeaders, probeTimeoutMs);
    if (probe.kind === "ok") return adopt(url, probe.data, customHeaders);
    if (probe.kind !== "not-json") continue;

    // Something is there, but the body was not JSON. On a StingStream node that is the gateway's
    // placeholder page — served at 200 for every path it does not know — and Jellyfin is one
    // level down. Probing for it costs one request and turns the address a node's owner is most
    // likely to type into the one that works.
    if (alreadyNested(host)) {
      answeredButNotJellyfin = true;
      continue;
    }
    const nested = `${url}/${JELLYFIN_SUBPATH}`;
    writeInfoLog(
      `Server check: ${url} answered something that is not Jellyfin; trying ${nested}`,
    );
    const under = await probePublicInfo(nested, customHeaders, probeTimeoutMs);
    if (under.kind === "ok") return adopt(nested, under.data, customHeaders);
    answeredButNotJellyfin = true;
  }

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
  /** Answered 2xx, but the body was not a JSON object — HTML, most likely a placeholder page. */
  | { kind: "not-json" }
  /** Nothing usable: refused, non-2xx, timed out, or the network failed. */
  | { kind: "miss" };

/**
 * Ask one base URL whether it is a Jellyfin server.
 *
 * @param url The base to probe, without a trailing slash.
 * @param customHeaders Proxy headers the user just entered, or undefined to reuse what is saved.
 * @param probeTimeoutMs How long to wait before giving up on this one.
 * @returns What came back.
 * @throws ServerTooOldError When it is Jellyfin, but older than Streamyfin supports.
 */
async function probePublicInfo(
  url: string,
  customHeaders: CustomHeader[] | undefined,
  probeTimeoutMs: number,
): Promise<Probe> {
  // A dead HTTPS port on a LAN IP can leave the connection hanging instead
  // of refusing it, which would block the http fallback forever.
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), probeTimeoutMs);
  try {
    const headers = normalizeCustomHeaders(
      customHeaders ?? getServerCustomHeaders(url),
    );
    const response = await fetch(
      `${url}/System/Info/Public`,
      optionsWithOptionalHeaders(
        { mode: "cors" as const, signal: abort.signal },
        headers,
      ),
    );
    if (!response.ok) {
      // WARN, not ERROR: probe failures are routine (http probe against an
      // https-only server, typos, offline) and must not become Sentry
      // events — they stay in the local log and breadcrumb trail.
      writeToLog(
        "WARN",
        `Server check: ${url} answered HTTP ${response.status}`,
      );
      return { kind: "miss" };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      writeToLog(
        "WARN",
        `Server check: ${url} answered 200 with a body that is not JSON`,
      );
      return { kind: "not-json" };
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      writeToLog(
        "WARN",
        `Server check: ${url} answered 200 with JSON that is not a Jellyfin document`,
      );
      return { kind: "not-json" };
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

/** Accept a base that answered, persisting the headers now they are known to reach it. */
function adopt(
  url: string,
  data: PublicSystemInfo,
  customHeaders: CustomHeader[] | undefined,
): CheckedServer {
  // Only persist the headers once they are known to reach the server.
  if (customHeaders !== undefined) {
    updateServerCustomHeaders(url, customHeaders);
  }
  writeInfoLog(
    `Server check: ${url} OK — "${data.ServerName}" v${data.Version}`,
  );
  return { url, name: data.ServerName || "" };
}
