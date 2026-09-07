import { readNodeContext } from "@/hooks/useNodeContext";
import { storage } from "./mmkv";

/**
 * Which servers have already told us they have no centralised-settings plugin.
 *
 * pass-02 F-23: `GET /jellyfin/Streamyfin/config` 404s on every single page
 * load of a StingStream node, because the node's own Jellyfin has never had
 * that plugin and never will. The request itself is harmless — the caller
 * already treats a failure as "no plugin" — but a browser prints every 4xx
 * subresource to the console, so the very first thing a developer or a
 * screenshot sweep sees on Home is a red line about a component that does not
 * exist. "Zero console errors on every screen is an acceptance gate", and a
 * feature probe that fires on mount, on foreground and after every sign-in is
 * the loudest thing standing between us and it.
 *
 * So it is asked *once per server* and the "no" is remembered. Not a
 * `useRef`, not a module variable: the probe runs again on every cold start,
 * and MMKV is what makes "once" mean once rather than once per launch.
 */
const ABSENT_SERVERS_KEY = "pluginConfigAbsentServers";

/** Plenty for a household; stops a wandering client growing the list forever. */
const MAX_REMEMBERED = 32;

/**
 * A server's identity for this cache: its base URL, normalised so
 * `http://host:8790/jellyfin` and `http://host:8790/jellyfin/` are one server
 * rather than two. Falsy input is refused rather than cached under "".
 */
export const serverProbeKey = (basePath: string | null | undefined) => {
  const trimmed = basePath?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed.toLowerCase() : null;
};

const readAbsent = (): string[] => {
  try {
    return storage.get<string[]>(ABSENT_SERVERS_KEY) ?? [];
  } catch {
    // A cache that cannot be read is a cache miss, not a failure: the worst
    // case is one extra probe.
    return [];
  }
};

/** Has this server already answered "no plugin here"? */
export const isPluginConfigKnownAbsent = (
  basePath: string | null | undefined,
): boolean => {
  const key = serverProbeKey(basePath);
  if (!key) return false;
  return readAbsent().includes(key);
};

/** Remember that this server has no plugin, so nothing asks it again. */
export const rememberPluginConfigAbsent = (
  basePath: string | null | undefined,
): void => {
  const key = serverProbeKey(basePath);
  if (!key) return;
  try {
    const absent = readAbsent();
    if (absent.includes(key)) return;
    storage.setAny(ABSENT_SERVERS_KEY, [...absent, key].slice(-MAX_REMEMBERED));
  } catch {
    // Not being able to persist the answer costs a repeat probe, nothing more.
  }
};

/** Forget a server's answer — an admin who has just installed the plugin. */
export const forgetPluginConfigAbsent = (
  basePath: string | null | undefined,
): void => {
  const key = serverProbeKey(basePath);
  if (!key) return;
  try {
    const absent = readAbsent();
    if (!absent.includes(key)) return;
    storage.setAny(
      ABSENT_SERVERS_KEY,
      absent.filter((entry) => entry !== key),
    );
  } catch {
    /* Nothing to do; the next explicit refresh probes anyway. */
  }
};

/**
 * Whether the plugin is worth asking about at all on this server.
 *
 * A StingStream node bundles its own Jellyfin and its own settings story; the
 * upstream centralised-settings plugin is not installed on it and cannot be.
 * The node says so about itself before the bundle has run a line (the marker
 * `hooks/useNodeContext.ts` reads), so the probe is skipped outright there
 * rather than being asked once and cached — which is the difference between a
 * fresh browser profile seeing one console error and seeing none.
 *
 * Any other server — somebody's own Jellyfin, which really might have the
 * plugin — is asked exactly once, and the answer is remembered.
 */
export const shouldProbePluginConfig = (
  basePath: string | null | undefined,
): boolean => {
  if (!basePath) return false;
  if (isServedByNode(basePath)) return false;
  return !isPluginConfigKnownAbsent(basePath);
};

/** Is this the Jellyfin a StingStream node is serving us? */
const isServedByNode = (basePath: string): boolean => {
  const node = readNodeContext();
  if (!node) return false;
  const nodeJellyfin = serverProbeKey(`${node.origin}${node.jellyfinPath}`);
  return nodeJellyfin != null && serverProbeKey(basePath) === nodeJellyfin;
};
