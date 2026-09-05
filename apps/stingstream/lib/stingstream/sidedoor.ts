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
 * public DNS name, which breaks `lan.<nodeid>` specifically. {@link diagnoseRebinding} spots the
 * signature — the LAN *name* failed while the LAN *address* answers — and
 * {@link plainLanFallback} produces the plain-HTTP URL that still works, with a warning the UI is
 * expected to show, because it is genuinely a downgrade.
 */

/** The three kinds of hostname a node publishes, plus the un-encrypted fallback. */
export type SideDoorKind = "lan" | "pub" | "relay" | "lan-ip-http";

export interface SideDoorCandidate {
  kind: SideDoorKind;
  host: string;
  port: number;
  /** `https://host:port`. Built by the node so a client never has to reassemble it. */
  url: string;
}

/** `ok`, `blocked` or `unknown` — the coordinator's last verdict on the `pub` name. */
export type DirectHttps = "ok" | "blocked" | "unknown";

/**
 * What a node publishes about its side door. Mirrors `stingstream_mesh::sidedoor::SideDoor`;
 * every optional field really can be missing, because the Rust side skips `None`.
 */
export interface SideDoorRecord {
  /** The node id in z-base-32 — the label inside every hostname. */
  node: string;
  zone?: string;
  coordinator?: string;
  candidates: SideDoorCandidate[];
  direct_https?: DirectHttps;
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
  direct_https?: DirectHttps;
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
 * They are raced in parallel, so the order is a tie-break rather than a priority — but it is a
 * real one: `lan` is started first because when it works it wins by an order of magnitude, and
 * `relay` last because it is the only one that always costs a second hop through somebody else's
 * server.
 *
 * A `pub` name the coordinator has already found unreachable is dropped rather than raced. That
 * verdict comes from a real TLS handshake attempted from outside, which is a much better test than
 * anything this side can run, and skipping it saves the client a full timeout on the one candidate
 * most likely to hang rather than fail.
 */
export function candidatesToTry(record: SideDoorRecord): SideDoorCandidate[] {
  const order: SideDoorKind[] = ["lan", "pub", "relay"];
  const blocked = record.direct_https === "blocked";
  return order
    .map((kind) => record.candidates.find((c) => c.kind === kind))
    .filter((c): c is SideDoorCandidate => !!c)
    .filter((c) => !(blocked && c.kind === "pub"));
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
  const lanName = outcomes.find((o) => o.candidate.kind === "lan");
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

/** z-base-32, the encoding every side-door hostname uses. */
const Z32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

/**
 * A node id in the form its hostnames use.
 *
 * The mesh reports node ids as 64 hex characters, which is what iroh prints; a DNS label holds 63,
 * so the side door uses z-base-32 instead (52 characters for the same 32 bytes). This is the
 * conversion, and it is the only place in the app that needs to know the difference.
 */
export function nodeIdToZ32(hex: string): string | null {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) return null;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(Number.parseInt(clean.slice(i, i + 2), 16));
  }
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += Z32[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // The last group is left-aligned and zero-padded, which is what z-base-32 specifies.
  if (bits > 0) out += Z32[(buffer << (5 - bits)) & 31];
  return out;
}

/** The inverse, so the conversion can be checked rather than believed. */
export function z32ToNodeId(z32: string): string | null {
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const ch of z32.trim()) {
    const v = Z32.indexOf(ch);
    if (v < 0) return null;
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The coordinator's public discovery record, `GET /node/v1/{node}`. */
export interface DiscoveryRecord {
  node: string;
  names?: {
    lan: string;
    public: string;
    relay: string;
    wildcard: string;
    acme_challenge: string;
  };
  direct_https?: DirectHttps;
  last_probe?: string;
  updated_at?: string;
}

/**
 * Build a racing record from the coordinator's public discovery record.
 *
 * The fallback path, for when the home node's own API has not passed the side door through: the
 * coordinator publishes the same three names to anyone who asks. What it does *not* publish is the
 * ports — it has no reason to know them — so they are supplied here, defaulting to the gateway's
 * 8790 and the SNI router's 443. A node with a port mapping on some other number is the case this
 * cannot serve, which is why the node's own record is preferred when it is available.
 */
export function sideDoorFromDiscovery(
  record: DiscoveryRecord,
  opts: { httpsPort?: number; relayPort?: number } = {},
): SideDoorRecord | null {
  if (!record.names) return null;
  const httpsPort = opts.httpsPort ?? 8790;
  const relayPort = opts.relayPort ?? 443;
  const mk = (kind: SideDoorKind, host: string, port: number) => ({
    kind,
    host,
    port,
    url: `https://${host}:${port}`,
  });
  return {
    node: record.node,
    candidates: [
      mk("lan", record.names.lan, httpsPort),
      mk("pub", record.names.public, httpsPort),
      mk("relay", record.names.relay, relayPort),
    ],
    direct_https: record.direct_https,
    updated_at: record.updated_at,
  };
}

/** Fetch that record from a coordinator. `null` when the coordinator has never seen the node. */
export async function fetchDiscoveryRecord(
  coordinatorUrl: string,
  nodeZ32: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<DiscoveryRecord | null> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const base = coordinatorUrl.replace(/\/+$/, "");
  try {
    const res = await fetchImpl(`${base}/node/v1/${nodeZ32}`, {
      credentials: "omit",
      cache: "no-store",
      signal: opts.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as DiscoveryRecord;
  } catch {
    return null;
  }
}
