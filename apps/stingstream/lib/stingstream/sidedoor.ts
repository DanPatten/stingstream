/**
 * The HTTPS side door, client half: racing a node's candidate hostnames.
 *
 * A native build talks to its home node over the mesh and never comes near this. A **browser**
 * cannot: it cannot speak iroh, and it will only trust a hostname with a publicly trusted
 * certificate on the other end. So every node publishes three names, all covered by one wildcard
 * certificate it holds the key to (`docs/SIDEDOOR.md`):
 *
 * | Candidate | Where it points | Wins when |
 * |---|---|---|
 * | `lan.<nodeid>.direct.<host>` | the node's private address | you are on the same network |
 * | `pub.<nodeid>.direct.<host>` | the node's public address | you are away and the node is reachable |
 * | `relay.<nodeid>.direct.<host>` | the coordinator, tunnelling over iroh | CGNAT, no port mapping, or a 443-only network |
 *
 * Which one works depends entirely on where the browser is standing, and asking is far cheaper
 * than reasoning: {@link raceSideDoor} opens all of them at once, keeps the first that answers,
 * and abandons the rest. A round trip on a LAN is a couple of milliseconds; the whole race is
 * bounded by {@link DEFAULT_TIMEOUT_MS}.
 *
 * ## Why `/sidedoor/v1/hello` and not `/healthz`
 *
 * These probes are cross-origin — the page was served by one candidate and is testing the others —
 * so they need CORS. `/healthz` carries the node's child ports, its data directory and its whole
 * side-door state, and must not be readable by any page on the internet that can reach the node.
 * `/sidedoor/v1/hello` exists for exactly this and says three things: which node answered, whether
 * the connection was TLS, and what address the node sees the caller at.
 *
 * ## Remembering the winner
 *
 * The address in that answer is the network's identity, and it costs nothing to obtain because the
 * node has to tell us anyway. So the winner is remembered under it: come back on the same network
 * and the stored URL is tried first, alone; move to another network and the key changes and the
 * race runs again. Storage failures (a private window, a browser that blocks site data) are not
 * errors — they cost one race.
 *
 * ## DNS rebinding
 *
 * Some routers (OpenWrt's dnsmasq, pfSense, Fritz!Box) refuse to return a private address from a
 * public DNS name — which breaks a domain somebody has pointed at their own machine.
 * {@link diagnoseRebinding} spots the signature — the *name* failed while the LAN *address*
 * answers — and
 * {@link plainLanFallback} produces the plain-HTTP URL that still works, with a warning the UI is
 * expected to show, because it is genuinely a downgrade.
 */

/**
 * Where a browser can try to reach a node.
 *
 * There used to be three HTTPS names, all under a coordinator's DNS zone and all covered by one
 * wildcard certificate. With the coordinator gone (Part 5) a node has at most one address — the
 * domain its owner pointed at it — so there is one kind to race, and the plain-HTTP LAN fallback
 * beneath it.
 */
export type SideDoorKind = "own" | "lan-ip-http";

export interface SideDoorCandidate {
  kind: SideDoorKind;
  host: string;
  port: number;
  /** `https://host:port`. Built by the node so a client never has to reassemble it. */
  url: string;
}

/**
 * What a node publishes about its side door. Mirrors `stingstream_mesh::sidedoor::SideDoor`;
 * every optional field really can be missing, because the Rust side skips `None`.
 */
export interface SideDoorRecord {
  /** The node id, so a remembered winner is keyed to the node it was raced for. */
  node: string;
  candidates: SideDoorCandidate[];
  cert_expiry?: string;
  /** The node's private addresses, for the DNS-rebinding fallback. */
  lan_ips?: string[];
  public_ip?: string;
  mapped_port?: number;
  /** The node's plain-HTTP gateway port, for that same fallback. */
  http_port?: number;
  updated_at?: string;
}

/** What `/sidedoor/v1/hello` answers. */
export interface Hello {
  ok: boolean;
  node: string;
  secure: boolean;
  client_ip?: string | null;
  /** Whether the node is serving HTTPS at all: `off`, `no_certificate` or `ready`. */
  https?: "off" | "no_certificate" | "ready";
}

/** One candidate's outcome. */
export interface ProbeOutcome {
  candidate: SideDoorCandidate;
  ok: boolean;
  ms: number;
  hello?: Hello;
  error?: string;
}

/** The candidate that won, and what it told us. */
export interface SideDoorChoice {
  url: string;
  kind: SideDoorKind;
  /** False only for the plain-HTTP rebinding fallback. */
  secure: boolean;
  /** The address the node sees this client at — the key the winner is remembered under. */
  clientIp?: string;
  ms: number;
  /** Set when the choice is a downgrade the user should be told about. */
  warning?: string;
}

/** Per-candidate timeout. A LAN round trip is milliseconds; a dead name is a full timeout. */
export const DEFAULT_TIMEOUT_MS = 4000;
/** How long a remembered winner is trusted before it is re-raced anyway. */
export const WINNER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const REBINDING_WARNING =
  "Your router refuses to answer this node's LAN hostname with its private address " +
  "(DNS rebinding protection), so this connection is plain HTTP and not encrypted. " +
  "To fix it, allow the domain in your router's DNS settings.";

const STORAGE_PREFIX = "stingstream.sidedoor.winner.";
const LAST_SUFFIX = "last";

// ---------------------------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------------------------

/**
 * Which candidates to open, in the order they should be started.
 *
 * A node has at most one HTTPS address now — the domain its owner pointed at it — so this is a
 * list of one, or of none. It stays a list because [`raceSideDoor`] races it against the
 * plain-HTTP LAN fallback and picks the encrypted winner, and because a node with two addresses is
 * a plausible thing to want later.
 */
export function candidatesToTry(record: SideDoorRecord): SideDoorCandidate[] {
  return record.candidates.filter((c) => c.kind === "own");
}

/** The plain-HTTP URL for a node's LAN address, or `null` when it published none. */
export function plainLanFallback(
  record: SideDoorRecord,
): SideDoorCandidate | null {
  const ip = record.lan_ips?.[0];
  const port = record.http_port;
  if (!ip || !port) return null;
  // A bare IPv6 address needs brackets in a URL, and `lan_ips` carries it bare.
  const host = ip.includes(":") ? `[${ip}]` : ip;
  return {
    kind: "lan-ip-http",
    host: ip,
    port,
    url: `http://${host}:${port}`,
  };
}

/**
 * Did DNS rebinding protection break the LAN name?
 *
 * The signature is specific and worth being strict about: the LAN *hostname* failed, and the LAN
 * *address* answered. Either half alone means something else — a node that is simply not on this
 * network, or a name that resolved perfectly well.
 */
export function diagnoseRebinding(outcomes: ProbeOutcome[]): {
  rebinding: boolean;
  reason: string;
} {
  const lanName = outcomes.find((o) => o.candidate.kind === "own");
  const lanIp = outcomes.find((o) => o.candidate.kind === "lan-ip-http");
  if (!lanName || !lanIp) {
    return { rebinding: false, reason: "not enough was tried to tell" };
  }
  if (lanName.ok)
    return { rebinding: false, reason: "the LAN hostname worked" };
  if (!lanIp.ok) {
    return {
      rebinding: false,
      reason: "this client is not on the node's network",
    };
  }
  return {
    rebinding: true,
    reason: "the LAN hostname failed while the LAN address answered",
  };
}

// ---------------------------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------------------------

export interface RaceOptions {
  /** Per-candidate timeout. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injected for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Abort the whole race. */
  signal?: AbortSignal;
  /** Where to remember the winner. Defaults to `localStorage` when there is one. */
  store?: WinnerStore;
  /** Skip the stored winner and race everything. */
  ignoreRemembered?: boolean;
  /** Injected for tests. */
  now?: () => number;
}

/**
 * Ask one candidate whether it is this node.
 *
 * Resolves rather than rejects: a race wants an outcome per candidate, not an exception. A reply
 * from a *different* node counts as a failure — a hostile or merely stale DNS answer that lands on
 * somebody else's StingStream must not be treated as a win.
 */
export async function probeCandidate(
  candidate: SideDoorCandidate,
  expectedNode: string,
  opts: RaceOptions = {},
): Promise<ProbeOutcome> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort);
  try {
    const res = await fetchImpl(`${candidate.url}/sidedoor/v1/hello`, {
      method: "GET",
      // No cookies, no credentials: this is a reachability question, and sending
      // a session to a hostname that may not be the node would be worse than useless.
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        candidate,
        ok: false,
        ms: now() - started,
        error: `HTTP ${res.status}`,
      };
    }
    const hello = (await res.json()) as Hello;
    if (expectedNode && hello.node && hello.node !== expectedNode) {
      return {
        candidate,
        ok: false,
        ms: now() - started,
        error: `answered for node ${hello.node}, not ${expectedNode}`,
      };
    }
    return { candidate, ok: true, ms: now() - started, hello };
  } catch (e) {
    return {
      candidate,
      ok: false,
      ms: now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Open every candidate at once and keep the first that answers.
 *
 * Returns `null` when nothing did, *including* the plain-HTTP fallback — which is the honest
 * answer for a node that is switched off, and different from "we found something insecure".
 */
export async function raceSideDoor(
  record: SideDoorRecord,
  opts: RaceOptions = {},
): Promise<SideDoorChoice | null> {
  const store = opts.store ?? defaultStore();
  const now = opts.now ?? (() => Date.now());

  // A remembered winner is tried alone first. One round trip when it is still right, which is the
  // common case, and one wasted timeout when it is not.
  if (!opts.ignoreRemembered) {
    const remembered = recallWinner(record.node, store, now);
    if (remembered) {
      const candidate =
        record.candidates.find((c) => c.url === remembered.url) ??
        (remembered.kind === "lan-ip-http" ? plainLanFallback(record) : null);
      if (candidate) {
        const outcome = await probeCandidate(candidate, record.node, opts);
        if (outcome.ok) return toChoice(outcome, record, store, now);
      }
    }
  }

  const candidates = candidatesToTry(record);
  const fallback = plainLanFallback(record);
  // The plain fallback is raced alongside the rest, not after them: it is the only way to tell
  // DNS rebinding (the address answers, the name does not) from "this node is elsewhere", and
  // running it afterwards would double the wait for the network where it matters.
  const all = fallback ? [...candidates, fallback] : candidates;
  if (all.length === 0) return null;

  const outcomes = await Promise.all(
    all.map((c) => probeCandidate(c, record.node, opts)),
  );
  const winner = pickWinner(outcomes);
  if (!winner) return null;
  const choice = toChoice(winner, record, store, now);
  if (winner.candidate.kind === "lan-ip-http") {
    const { rebinding } = diagnoseRebinding(outcomes);
    choice.warning = rebinding
      ? REBINDING_WARNING
      : "This connection is plain HTTP and is not encrypted.";
  }
  return choice;
}

/**
 * Pick the winner from a completed set of outcomes.
 *
 * **Not** simply "the fastest". An encrypted candidate always beats the plain-HTTP fallback, even
 * a slower one: the fallback exists for a network where nothing else works, and letting it win a
 * race on speed would quietly drop every user on a fast LAN to un-encrypted HTTP. Among the
 * encrypted ones, fastest wins.
 */
export function pickWinner(outcomes: ProbeOutcome[]): ProbeOutcome | null {
  const ok = outcomes.filter((o) => o.ok);
  if (ok.length === 0) return null;
  const secure = ok.filter((o) => o.candidate.kind !== "lan-ip-http");
  const pool = secure.length > 0 ? secure : ok;
  return pool.reduce((best, o) => (o.ms < best.ms ? o : best));
}

function toChoice(
  outcome: ProbeOutcome,
  record: SideDoorRecord,
  store: WinnerStore | null,
  now: () => number,
): SideDoorChoice {
  const choice: SideDoorChoice = {
    url: outcome.candidate.url,
    kind: outcome.candidate.kind,
    secure: outcome.candidate.kind !== "lan-ip-http",
    clientIp: outcome.hello?.client_ip ?? undefined,
    ms: outcome.ms,
  };
  rememberWinner(record.node, choice, store, now);
  return choice;
}

// ---------------------------------------------------------------------------------------------
// Remembering
// ---------------------------------------------------------------------------------------------

/** The two calls this module needs from a key/value store. Both may throw; both are caught. */
export interface WinnerStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RememberedWinner {
  url: string;
  kind: SideDoorKind;
  /** The address the node saw us at when this was recorded. */
  clientIp?: string;
  at: number;
}

/** `localStorage`, when there is one that works. */
export function defaultStore(): WinnerStore | null {
  try {
    const ls = (globalThis as { localStorage?: WinnerStore }).localStorage;
    if (!ls) return null;
    // Some browsers expose `localStorage` and throw on touch (site data blocked, private mode).
    ls.getItem(`${STORAGE_PREFIX}probe`);
    return ls;
  } catch {
    return null;
  }
}

function key(node: string, clientIp?: string): string {
  return `${STORAGE_PREFIX}${node}.${clientIp ?? LAST_SUFFIX}`;
}

/**
 * Remember a winner, under the network it won on *and* as the node's last-known-good.
 *
 * Two entries on purpose. The per-network one is the fast path on a network we have seen before;
 * the last-known-good is what makes the very first load on a *new* network still start with one
 * plausible guess rather than a full race.
 */
export function rememberWinner(
  node: string,
  choice: SideDoorChoice,
  store: WinnerStore | null = defaultStore(),
  now: () => number = () => Date.now(),
): void {
  if (!store) return;
  const value: RememberedWinner = {
    url: choice.url,
    kind: choice.kind,
    clientIp: choice.clientIp,
    at: now(),
  };
  const json = JSON.stringify(value);
  try {
    store.setItem(key(node), json);
    if (choice.clientIp) store.setItem(key(node, choice.clientIp), json);
  } catch {
    // A full or blocked store costs one race next time, and nothing else.
  }
}

/**
 * The winner to try first, if there is a fresh one.
 *
 * `clientIp` is not known before the first successful connection, so this deliberately falls back
 * to the node's last-known-good rather than insisting on a network match — the entry is validated
 * by an actual probe either way, so a wrong guess costs a timeout and not a wrong answer.
 */
export function recallWinner(
  node: string,
  store: WinnerStore | null = defaultStore(),
  now: () => number = () => Date.now(),
  clientIp?: string,
): RememberedWinner | null {
  if (!store) return null;
  for (const k of clientIp ? [key(node, clientIp), key(node)] : [key(node)]) {
    try {
      const raw = store.getItem(k);
      if (!raw) continue;
      const value = JSON.parse(raw) as RememberedWinner;
      if (!value?.url) continue;
      if (now() - value.at > WINNER_TTL_MS) {
        store.removeItem(k);
        continue;
      }
      return value;
    } catch {
      // Unreadable or corrupt: fall through to the next key, then to a full race.
    }
  }
  return null;
}

export function forgetWinner(
  node: string,
  store: WinnerStore | null = defaultStore(),
  clientIp?: string,
): void {
  if (!store) return;
  for (const k of clientIp ? [key(node), key(node, clientIp)] : [key(node)]) {
    try {
      store.removeItem(k);
    } catch {
      // Nothing to do and nothing to report.
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Building a record from what the app can already see
// ---------------------------------------------------------------------------------------------

/**
 * The one HTTPS address a node has, if its owner has set one.
 *
 * This used to be assembled from a coordinator's discovery record, which minted three hostnames
 * under its own DNS zone. There is no coordinator now, so the only address a node can have is the
 * one somebody pointed at it under Settings → Sharing — and that is a string the node already
 * hands the app.
 *
 * `null` for the ordinary case of a node with no domain: it is reachable on its own network and
 * through the app's mesh, and a browser away from home has nothing to try. Saying so is better
 * than racing something that cannot work.
 */
export function ownAddressRecord(
  node: string,
  publicAddress: string | null | undefined,
  lan?: { ips?: string[]; httpPort?: number },
): SideDoorRecord | null {
  const address = publicAddress?.trim().replace(/\/+$/, "");
  if (!address) return null;

  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  const port = url.port ? Number(url.port) : 443;
  return {
    node,
    candidates: [
      {
        kind: "own",
        host: url.hostname,
        port,
        url: `${url.protocol}//${url.host}`,
      },
    ],
    lan_ips: lan?.ips,
    http_port: lan?.httpPort,
  };
}
