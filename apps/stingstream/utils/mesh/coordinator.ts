/**
 * The coordinator picker's validation.
 *
 * A group may carry a coordinator URL — optional infrastructure that adds rendezvous (so a join
 * works when the inviter is offline), a relay on TCP 443 and the HTTPS side door. The default is
 * to have none at all: iroh's public relays, n0 DNS and the mainline DHT already make a group
 * work with nothing hosted anywhere (`docs/MESH.md` §1).
 *
 * Typing a hostname that turns out not to be a coordinator is a mistake that only shows up much
 * later, as joins that quietly fall back — so the picker checks it live against the coordinator's
 * own `/healthz`, which says what it is and what it can do.
 */

/** What `stingstream-relay` answers on `GET /healthz` (`mesh/crates/stingstream-relay/src/http.rs`). */
export interface CoordinatorHealth {
  ok: boolean;
  /** `lite` or `full`. */
  mode: string;
  version: string;
  uptime_secs: number;
  relay: boolean;
  /**
   * Whether this coordinator answers iroh's QUIC address-discovery probes. Lite is TCP-only and
   * never does, which is fine — the relay map keeps a UDP-capable relay for that job.
   */
  quic_address_discovery: boolean;
  rendezvous: boolean;
  sni_router: boolean;
  dns_zone: string | null;
  dns_provider: string;
  /**
   * Live counts, on a coordinator old enough to publish them.
   *
   * Optional because M8b stopped sending them: `/healthz` on a coordinator has to answer before
   * anything is configured — it is the container health check, and it has no credentials by design
   * — so a live census of node, group and rendezvous-entry counts was being handed to anybody who
   * asked, from a system whose rendezvous store deliberately refuses to be an enumeration oracle.
   * Nothing here ever read them (`describeCoordinator` uses the capability booleans), so this is a
   * type correction rather than a behaviour change; they stay declared so a coordinator that still
   * sends them is not a parse error.
   */
  nodes?: number;
  groups?: number;
  entries?: number;
}

export type CoordinatorCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; url: string; health: CoordinatorHealth }
  | { state: "invalid"; message: string }
  | { state: "unreachable"; url: string; message: string }
  | { state: "not-a-coordinator"; url: string; message: string };

/**
 * Turn what the user typed into the URL the group will carry.
 *
 * Accepts a bare hostname (`coord.example.org`), a full URL, and a hostname with a port. Forces
 * `https` when no scheme was given: the coordinator's whole design assumes TLS on 443, and a
 * silently-plain-HTTP coordinator would hand every member's rendezvous traffic to the network.
 * An explicit `http://` is honoured, because that is what a developer running one on localhost
 * needs, and it is a deliberate act rather than a default.
 *
 * Returns `null` for anything that is not a usable host.
 */
export const normalizeCoordinatorUrl = (input: string): string | null => {
  const raw = input.trim();
  if (!raw) return null;

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!parsed.hostname) return null;
  // A hostname has to have a shape a certificate could ever match. `localhost` is the one bare
  // label that is genuinely useful, for a coordinator being developed on this machine.
  if (
    !parsed.hostname.includes(".") &&
    parsed.hostname !== "localhost" &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)
  ) {
    return null;
  }
  // The mesh stores an origin, not a path: everything it asks for is a fixed absolute path
  // underneath. A trailing slash would end up doubled in `https://host//rendezvous/...`.
  return `${parsed.protocol}//${parsed.host}`;
};

/**
 * Ask a candidate coordinator what it is.
 *
 * Distinguishes three failures the user has to act on differently: a hostname that is not a URL,
 * a host that does not answer, and a host that answers but is not a coordinator (a web server on
 * the same name, most likely).
 */
export const checkCoordinator = async (
  input: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CoordinatorCheck> => {
  const url = normalizeCoordinatorUrl(input);
  if (!url) {
    return {
      state: "invalid",
      message: "That does not look like a hostname.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 6000,
  );
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  try {
    const res = await fetch(`${url}/healthz`, { signal: controller.signal });
    if (!res.ok) {
      return {
        state: "not-a-coordinator",
        url,
        message: `${url} answered ${res.status} on /healthz.`,
      };
    }
    const health = (await res.json()) as CoordinatorHealth;
    // `mode` is the field only a StingStream coordinator has. Checking it is what stops a
    // Kubernetes ingress with its own /healthz from being accepted as one.
    if (!health || typeof health.mode !== "string" || !health.ok) {
      return {
        state: "not-a-coordinator",
        url,
        message: `${url} answered, but not like a StingStream coordinator.`,
      };
    }
    return { state: "ok", url, health };
  } catch (error) {
    const aborted = (error as Error)?.name === "AbortError";
    return {
      state: "unreachable",
      url,
      message: aborted
        ? `${url} did not answer in time.`
        : `Could not reach ${url}.`,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
};

/** A one-line summary of what a healthy coordinator is offering, for the picker. */
export const describeCoordinator = (health: CoordinatorHealth): string => {
  const offers = [
    health.relay ? "relay" : null,
    health.rendezvous ? "rendezvous" : null,
    health.sni_router ? "side door" : null,
    health.dns_zone ? `DNS (${health.dns_zone})` : null,
  ].filter(Boolean);
  const mode = health.mode === "full" ? "Full" : "Lite";
  return `${mode} mode, v${health.version} — ${offers.join(", ") || "nothing enabled"}`;
};

/** Where "Host your own" goes. */
export const COORDINATOR_GUIDE_URL =
  "https://github.com/DanPatten/stingstream/blob/master/deploy/coordinator/README.md";
