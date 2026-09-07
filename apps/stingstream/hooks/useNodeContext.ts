/**
 * What the page knows about the node serving it, before a single request goes out.
 *
 * A StingStream node's gateway splices a marker into the `index.html` it serves — a
 * `<meta name="stingstream-node">` tag and a `window.__STINGSTREAM_NODE__` object (see
 * `mesh/crates/stingstream/src/gateway/web.rs`). Reading it is *synchronous*, which is the whole
 * point: the app can decide what to show before first paint instead of flashing "Enter the URL to
 * your server" while a probe is in flight. That flash was Dan's actual complaint about v0.1.0.
 *
 * The same bundle served by `npx serve`, or running under Metro, or installed on a phone, gets no
 * marker and no context — those really are not nodes, and they keep the address step.
 */
export interface NodeContext {
  /** Gateway root, no trailing slash — e.g. `http://localhost:8790`. */
  origin: string;
  /** Where the gateway puts Jellyfin, relative to `origin`. Always leading-slash. */
  jellyfinPath: string;
  /** Where the gateway puts StingStream.Core's API, relative to `origin`. */
  apiPath: string;
  /**
   * Whether *this* page load came from the machine the node runs on. A hint, not the authority:
   * `setup/state` answers the same question per request and is what the state machine acts on.
   */
  loopback: boolean;
  /**
   * Loopback, or a peer on the same private network — the two Dan wants able to see the
   * first-run "Create your StingStream account" screen rather than "finish it from a device on
   * your home network" (2026-09-07: "localhost only works on the same PC — by IP is better").
   * The marker sends its own value (WP-GATE, `Core`'s `SetupGate.IsTrustedPeer` computed against
   * the real socket peer), which wins whenever it is present; this field falls back to deriving
   * it client-side from this page's own hostname only for a marker old enough not to send one,
   * or the env-URL path (no marker at all). `setup/state`'s own `SetupState.trustedPeer` (see
   * `lib/stingstream/setup.ts`) is a second, fresher authority the state machine prefers once
   * that request lands — this field is what it has before then.
   */
  trustedPeer: boolean;
  /**
   * LAN addresses this node is reachable at (e.g. `["http://192.168.0.16:8790"]`), from the
   * marker's `addresses` array — empty for an untrusted peer or a node with none configured, by
   * the gateway's own design (never hinting at the shape of the network to a stranger). Prefer
   * this over `origin` when telling somebody where to go — `origin` is just however *this* page
   * got here, which on the node's own machine is `localhost` and means nothing to anyone else.
   */
  addresses: string[];
  /**
   * The gateway's cached view of whether this node still needs its first account. `null` means
   * nobody knew when the page was served (Core still starting) — a real answer, not an error.
   */
  setupPending: boolean | null;
  /** The node's own display name, for "Sign in to …". Never a machine or Jellyfin server name. */
  nodeName: string | null;
  /** The node's version string, when it told us. */
  version: string | null;
}

/** Everything `parseNodeMarker` needs from the document, gathered by the caller. */
export interface NodeMarkerInput {
  /** `window.__STINGSTREAM_NODE__`, whatever it turned out to be. */
  marker?: unknown;
  /** `window.location.origin`. */
  origin?: string | null;
  /** Whether `<meta name="stingstream-node">` is in the document. */
  meta?: boolean;
}

const DEFAULT_JELLYFIN_PATH = "/jellyfin";
const DEFAULT_API_PATH = "/stingstream/api/v1";

/**
 * The env var Metro dev and emulators use to stand in for a marker — an Android emulator reaches
 * the host node at `http://10.0.2.2:8790`, and a Metro-served web build is not a node at all.
 *
 * Read as a literal static member expression on purpose: Expo's babel plugin inlines
 * `process.env.EXPO_PUBLIC_*` at build time only when it is written exactly like this. Any
 * indirection — `process.env[NAME]`, a destructure — is left alone and comes back `undefined` in
 * a bundle, which is a silent failure rather than a loud one.
 */
const nodeUrlEnv = (): string | null =>
  process.env.EXPO_PUBLIC_STINGSTREAM_NODE_URL ?? null;

const trimOrigin = (value: string): string => value.trim().replace(/\/+$/, "");

/** A path the marker gave us, or the default when it gave us something unusable. */
const pathOr = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed.startsWith("/")) return fallback;
  return trimmed;
};

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/**
 * An absolute `http(s)` origin, or null. Anything else — a relative path, a `file:` URL, a typo —
 * is not something the app can connect to, and silently connecting to the wrong thing is worse
 * than showing the address form.
 */
const absoluteOrigin = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = trimOrigin(value);
  if (!trimmed) return null;
  if (!/^https?:\/\/[^/\s]+/i.test(trimmed)) return null;
  return trimmed;
};

/**
 * Loopback and RFC1918 / link-local / IPv6-ULA hosts: "this browser reached the node over a
 * private network", not "the whole internet can". This is the client-side fallback for markers
 * old enough not to send their own `trustedPeer` — WP-GATE's `Core`-side
 * `SetupGate.IsTrustedPeer`, computed against the real socket peer, is the authority and is what
 * every current marker and `setup/state` response actually carries — see `trustedPeer` on
 * `NodeContext`.
 */
const isPrivateOrLoopbackHost = (hostname: string): boolean => {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 -- also the Android emulator's host alias, 10.0.2.2
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    return false;
  }

  // IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host === "::1") return true;
  if (/^f[cd][0-9a-f]{0,2}(:|$)/i.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;

  return false;
};

/** The marker's own `trustedPeer` when it sent one; otherwise derived from `origin`'s host. */
const trustedPeerFor = (origin: string, markerValue: unknown): boolean => {
  if (typeof markerValue === "boolean") return markerValue;
  try {
    return isPrivateOrLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
};

/** The marker's `addresses` array, keeping only entries that are usable absolute origins. */
const addressesFor = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    const address = typeof entry === "string" ? absoluteOrigin(entry) : null;
    if (address) result.push(address);
  }
  return result;
};

/**
 * The marker (or the env fallback) as a `NodeContext`. Pure, so the rules are testable without a
 * DOM: every branch here has a case in `nodeContext.test.ts`.
 *
 * Order matters. A well-formed marker wins; a `<meta>` tag with a broken payload still counts as
 * "this is a node" (the tag is the presence signal, the script is the detail) and falls back to
 * the documented default paths; and only when the document says nothing at all does the env var
 * get a say — otherwise a stale `EXPO_PUBLIC_STINGSTREAM_NODE_URL` baked into a bundle would
 * override the node actually serving it.
 */
export function parseNodeMarker(
  input: NodeMarkerInput | null | undefined,
  fallbackEnv?: string | null,
): NodeContext | null {
  const origin = absoluteOrigin(input?.origin);
  const marker = input?.marker;
  const isRecord =
    typeof marker === "object" && marker !== null && !Array.isArray(marker);
  const fields = isRecord ? (marker as Record<string, unknown>) : null;

  if (origin && fields?.node === true) {
    return {
      origin,
      jellyfinPath: pathOr(fields.jellyfin, DEFAULT_JELLYFIN_PATH),
      apiPath: pathOr(fields.api, DEFAULT_API_PATH),
      loopback: fields.loopback === true,
      trustedPeer: trustedPeerFor(origin, fields.trustedPeer),
      addresses: addressesFor(fields.addresses),
      setupPending:
        typeof fields.setupPending === "boolean" ? fields.setupPending : null,
      nodeName: stringOrNull(fields.nodeName),
      version: stringOrNull(fields.version),
    };
  }

  // The tag is present but the payload is not usable. Still a node — an older or half-broken
  // marker must not send the user back to typing an address at the machine they are sitting at.
  if (origin && input?.meta === true) {
    return {
      origin,
      jellyfinPath: DEFAULT_JELLYFIN_PATH,
      apiPath: DEFAULT_API_PATH,
      loopback: false,
      trustedPeer: trustedPeerFor(origin, undefined),
      addresses: [],
      setupPending: null,
      nodeName: null,
      version: null,
    };
  }

  const envOrigin = absoluteOrigin(fallbackEnv);
  if (envOrigin) {
    return {
      origin: envOrigin,
      jellyfinPath: DEFAULT_JELLYFIN_PATH,
      apiPath: DEFAULT_API_PATH,
      // Unknown from here — `setup/state` answers both per request, and it is the authority.
      loopback: false,
      trustedPeer: trustedPeerFor(envOrigin, undefined),
      addresses: [],
      setupPending: null,
      nodeName: null,
      version: null,
    };
  }

  return null;
}

/** The full Jellyfin base URL to connect to — what `checkJellyfinServer` should be handed. */
export const jellyfinUrlFor = (context: NodeContext): string =>
  `${context.origin}${context.jellyfinPath}`;

/**
 * Where to tell somebody else to go: the marker's own LAN address first, `origin` only when it
 * offered none. `origin` is just however *this* page reached the node — on the node's own
 * machine that is `localhost`, which means nothing on any other device (2026-09-07 decision:
 * "localhost only works on the same PC — by IP is better").
 */
export const primaryAddressFor = (context: NodeContext): string =>
  context.addresses[0] ?? context.origin;

/**
 * Read the document. Web only; every other platform has no marker to read.
 *
 * `typeof document` rather than `Platform.OS`, deliberately: it is the exact question being
 * asked, it is true for every web build and false for every native one, and it keeps this module
 * free of a `react-native` import — which `bun:test` cannot parse, and which would otherwise put
 * the pure parsing rules below out of reach of a plain unit test.
 */
function readMarkerInput(): NodeMarkerInput | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  return {
    marker: (window as unknown as Record<string, unknown>).__STINGSTREAM_NODE__,
    origin: window.location?.origin ?? null,
    meta: document.querySelector('meta[name="stingstream-node"]') !== null,
  };
}

/**
 * The node context for this process, computed once.
 *
 * `window.__STINGSTREAM_NODE__` is written before the bundle runs and never changes afterwards, so
 * re-reading it per render buys nothing and a `useMemo` per component would recompute it per
 * mount. Cached at module scope instead; `resetNodeContextCache` exists for tests only.
 */
let cached: { value: NodeContext | null } | null = null;

export function readNodeContext(): NodeContext | null {
  if (!cached) {
    cached = { value: parseNodeMarker(readMarkerInput(), nodeUrlEnv()) };
  }
  return cached.value;
}

/** Test seam. Nothing in the app should need this. */
export function resetNodeContextCache(): void {
  cached = null;
}

/**
 * Whether this app is being served by a StingStream node, and what it said about itself.
 *
 * `null` on a phone build with no `EXPO_PUBLIC_STINGSTREAM_NODE_URL`, under a plain static web
 * server, and under `expo start --web` — all of which keep the address form.
 */
export function useNodeContext(): NodeContext | null {
  return readNodeContext();
}
