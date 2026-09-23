/**
 * Is the server there, and is it ready? Decided in pure functions, response in, state out.
 *
 * Why this exists: a returning browser, signed in from before, loads its bundle from a node's
 * gateway seconds to a minute before the media server behind it is routable. Every request in
 * that window gets `503` + `Retry-After` + `x-stingstream-state: starting` from the gateway
 * (`mesh/crates/stingstream/src/gateway/mod.rs`, `not_ready`). The connection check read that as
 * "not ok" and Home said **"Server unreachable"** with a Retry button, for a server that had
 * answered and said, in as many words, that it was coming up. The sign-in screen already knew the
 * difference (`ServerStartingError`); this is the same detection, shared, plus the timing rules
 * for how long "starting" is honest.
 */

import {
  SERVER_QUIET_POLL_MS,
  SERVER_STARTING_BUDGET_MS,
  SERVER_STARTING_FIRST_DELAY_MS,
  SERVER_STARTING_MAX_DELAY_MS,
  SERVER_UNREACHABLE_GRACE_MS,
} from "@/constants/ServerStartup";
import { PRODUCT_NAME } from "@/utils/serverUrl/probes/jellyfin";

/** The header the gateway puts on its own "not ready yet" answers: `starting` or `failed`. */
export const NODE_STATE_HEADER = "x-stingstream-state";

/**
 * Statuses that mean "there, but not ready yet".
 *
 * 503 is the node's gateway refusing to route to a child that is starting or backing off, or
 * Jellyfin's own start-up answer. 502 is an older gateway with nothing listening behind it yet.
 * 502 and 504 are also what a reverse proxy in front of a node says about the same state, and a
 * node behind Cloudflare Tunnel or Caddy is a documented setup (`docs/SIDEDOOR.md`).
 */
const STARTING_STATUSES = new Set([502, 503, 504]);

/** Whether a response says the server is there but not ready. */
export function isStartingResponse(
  status: number,
  stateHeader: string | null | undefined,
): boolean {
  if (stateHeader === "starting" || stateHeader === "failed") return true;
  return STARTING_STATUSES.has(status);
}

/**
 * What one readiness probe came back as.
 *
 * - `ok`: a Jellyfin document.
 * - `starting`: the node answered and is coming up.
 * - `failed`: the node answered and its supervisor has given up on the media server.
 * - `miss`: nothing answered (refused, timed out, DNS, TLS).
 * - `error`: something answered, and it was neither ready nor starting.
 */
export type ProbeReading = "ok" | "starting" | "failed" | "miss" | "error";

export interface ProbeResponse {
  /** HTTP status, absent when nothing answered. */
  status?: number;
  /** The `x-stingstream-state` header, when there was one. */
  stateHeader?: string | null;
  /** The parsed body, or the raw text when it was not JSON. */
  body?: unknown;
  /** True when the request never got a response. */
  networkError?: boolean;
}

/** Read one `/System/Info/Public` response. */
export function readProbeResponse(response: ProbeResponse): ProbeReading {
  if (response.networkError || response.status === undefined) return "miss";
  const { status, stateHeader, body } = response;
  if (stateHeader === "failed") return "failed";
  if (isStartingResponse(status, stateHeader)) return "starting";
  if (status < 200 || status >= 300) return "error";
  const isJellyfin =
    typeof body === "object" &&
    body !== null &&
    (body as { ProductName?: unknown }).ProductName === PRODUCT_NAME;
  return isJellyfin ? "ok" : "error";
}

/**
 * What the app shows about its server.
 *
 * - `checking`: nothing has been asked yet.
 * - `ok`: ready.
 * - `starting`: "Starting your server", with a spinner, polling.
 * - `stalled`: the wait ran past its budget. The stalled card, with Try again.
 * - `unreachable`: nothing answers. Reserved for exactly that.
 */
export type ServerState =
  | "checking"
  | "ok"
  | "starting"
  | "stalled"
  | "unreachable";

/** The stretch of not-ok answers the current one belongs to. */
export interface ServerWait {
  /** When the first not-ok answer of this stretch came back (ms since epoch). */
  since: number;
  /** Whether the node answered "starting" or "failed" at any point in this stretch. */
  answered: boolean;
  /** Whether "nothing answered" still counts as starting for a short while. See the grace. */
  graceful: boolean;
}

/**
 * Pick the state for the latest reading.
 *
 * A node that has said "starting" once in this stretch is alive: if it then goes quiet, that is
 * its gateway restarting, and it keeps the starting card rather than dropping to unreachable.
 */
export function decideServerState(
  reading: ProbeReading,
  wait: ServerWait,
  now: number,
): ServerState {
  if (reading === "ok") return "ok";
  if (reading === "failed") return "stalled";
  const elapsed = now - wait.since;
  if (reading === "starting" || wait.answered) {
    return elapsed < SERVER_STARTING_BUDGET_MS ? "starting" : "stalled";
  }
  if (wait.graceful && elapsed < SERVER_UNREACHABLE_GRACE_MS) return "starting";
  return "unreachable";
}

/**
 * How long to wait before asking again, or null when there is nothing to wait for.
 *
 * @param attempt How many polls this stretch has already made, starting at 0.
 */
export function nextPollDelay(
  state: ServerState,
  attempt: number,
): number | null {
  if (state === "ok" || state === "checking") return null;
  if (state === "starting") {
    return Math.min(
      SERVER_STARTING_FIRST_DELAY_MS * 2 ** attempt,
      SERVER_STARTING_MAX_DELAY_MS,
    );
  }
  return SERVER_QUIET_POLL_MS;
}
