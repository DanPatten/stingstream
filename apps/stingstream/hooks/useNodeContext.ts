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
   * Whether *this* page load came from the machine the node runs on. Only a local browser is
   * offered the first-run account screen. A hint, not the authority: `setup/state` answers the
   * same question per request and is what the state machine acts on.
   */
  loopback: boolean;
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
