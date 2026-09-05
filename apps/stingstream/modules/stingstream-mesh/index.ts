import type { EventSubscription } from "expo-modules-core";
import { Platform, requireNativeModule } from "expo-modules-core";

/**
 * The app's embedded mesh light node (Android and Android TV).
 *
 * The node joins the same groups the user's home node belongs to, and serves
 * `http://127.0.0.1:<localPort>/stream/<group>/<item_key>/<node>` on loopback. Anything that
 * hands a URL to a player or a downloader runs it through
 * {@link import("@/utils/mesh/streamUrl").rewriteMeshStreamUrl} first, which turns the
 * `stingstream.local` host a federated `.strm` file carries into that loopback port. When the node
 * is not running — web, an iOS build, a device that has joined no groups — the URL is left alone
 * and the home node proxies it instead. See `docs/APP-MESH.md`.
 *
 * There is no iOS or web implementation. Every function below degrades to "unavailable" rather
 * than throwing, so a screen can render the same code on all three.
 */

/** How the last connection to a peer was carried. `mixed` means a direct path exists. */
export type MeshPathKind = "direct" | "relay" | "mixed";

export type MeshStatus = {
  available: boolean;
  /** 64-character lowercase hex. */
  nodeId: string;
  /** What other members see in their Group screen. */
  nodeName: string;
  version: string;
  /** The loopback port the URL rewrite targets. `0` when the node is not running. */
  localPort: number;
  /** Always true for the app's node: it holds no library and serves no files. */
  light: boolean;
  groups: number;
  /** The relay this endpoint is homed on, if any. */
  homeRelay: string | null;
  relayUrls: string[];
  directAddrs: string[];
  directPeers: number;
  relayedPeers: number;
  /** Online peers nothing has been asked of yet, so their path is not known. */
  unknownPeers: number;
};

export type MeshGroup = {
  id: string;
  name: string;
  coordinator: string | null;
  createdAt: string;
  /** Members known to this node, including itself. */
  members: number;
  /** Members currently heartbeating, excluding this device. */
  online: number;
};

export type MeshPeer = {
  group: string;
  node: string;
  nodeName: string;
  online: boolean;
  isSelf: boolean;
  path: MeshPathKind | null;
  rttMs: number | null;
  lastSeen: string | null;
};

export type MeshJoinResult = {
  group: string;
  name: string;
  coordinator: string | null;
  /**
   * `inviter`, `rendezvous`, or `none` when the group was created locally but nobody answered.
   * `none` is a success the user should still be told about.
   */
  via: "inviter" | "rendezvous" | "none";
  contacted: string[];
};

export type MeshPeerEvent = {
  group: string;
  node: string;
  nodeName: string;
  path: MeshPathKind | null;
  rttMs: number | null;
};

export type MeshStreamStats = {
  group: string;
  itemKey: string;
  node: string;
  status: number;
  bytes: number | null;
  /** Time to response headers, not to the last byte. */
  ttfbMs: number;
  path: MeshPathKind | null;
  rttMs: number | null;
};

export type MeshStateEvent = {
  state: "running" | "stopped" | "error";
  message: string | null;
  localPort: number;
  nodeId: string | null;
};

/** What {@link startMesh} may override. Everything is optional. */
export type MeshStartConfig = {
  nodeName?: string;
  /** Leave this alone. The app's node is always a light member. */
  light?: boolean;
  n0Dns?: boolean;
  mainlineDht?: boolean;
  n0Relays?: boolean;
  /** `""` disables the built-in fallback coordinator entirely. */
  fallbackCoordinator?: string;
  logFilter?: string;
};

type NativeModule = {
  start(configJson: string | null): Promise<MeshStatus>;
  stop(): Promise<void>;
  isRunning(): boolean;
  isAvailable(): boolean;
  getLocalPort(): number;
  getNodeId(): string | null;
  getStatus(): Promise<MeshStatus>;
  joinGroup(invite: string): Promise<MeshJoinResult>;
  leaveGroup(group: string): Promise<boolean>;
  listGroups(): Promise<MeshGroup[]>;
  listPeers(group: string | null): Promise<MeshPeer[]>;
  setKeepAwake(keep: boolean): void;
  setIdleTimeoutMs(ms: number): void;
  addListener(
    event: string,
    listener: (payload: any) => void,
  ): EventSubscription;
};

// Android only, and wrapped: an unlinked module has to degrade to "unavailable" rather than take
// the bundle down at import time. That failure mode is exactly what M2 spent a day on
// (docs/M2-web-spike.md section 1), so the guard is deliberate rather than defensive habit.
const Native: NativeModule | null = (() => {
  if (Platform.OS !== "android") return null;
  try {
    return requireNativeModule<NativeModule>("StingstreamMesh");
  } catch {
    return null;
  }
})();

const NOOP_SUBSCRIPTION = { remove: () => {} } as EventSubscription;

/**
 * False on web, on iOS, and in any Android build without the Rust library.
 *
 * The Kotlin half of the module is always present once the app is built; the `.so` beside it is a
 * separate artifact that a debug build is allowed to be missing (see the module's build.gradle),
 * so this asks the native side whether the library actually loaded rather than assuming it did.
 * Memoised: the answer cannot change for the life of the process, and this is called on the
 * playback path.
 */
let availability: boolean | null = null;
export const isMeshAvailable = (): boolean => {
  if (availability !== null) return availability;
  if (!Native) {
    availability = false;
    return false;
  }
  try {
    availability = Native.isAvailable();
  } catch {
    availability = false;
  }
  return availability;
};

/**
 * Start the node, or return the running one's status.
 *
 * Returns `null` where the module does not exist, so a caller can write
 * `const status = await startMesh()` on every platform.
 */
export const startMesh = async (
  config?: MeshStartConfig,
): Promise<MeshStatus | null> => {
  if (!Native || !isMeshAvailable()) return null;
  try {
    return await Native.start(config ? JSON.stringify(config) : null);
  } catch (error) {
    console.warn("[StingstreamMesh] start failed:", error);
    return null;
  }
};

export const stopMesh = async (): Promise<void> => {
  if (!Native) return;
  try {
    await Native.stop();
  } catch (error) {
    console.warn("[StingstreamMesh] stop failed:", error);
  }
};

export const isMeshRunning = (): boolean => {
  if (!Native || !isMeshAvailable()) return false;
  try {
    return Native.isRunning();
  } catch {
    return false;
  }
};

/**
 * The loopback port, or `0` when there is nothing to rewrite to.
 *
 * Synchronous on purpose: the URL rewrite sits on the playback path and must not be able to
 * introduce a `await` between choosing a MediaSource and handing it to the player.
 */
export const getMeshLocalPort = (): number => {
  if (!Native || !isMeshAvailable()) return 0;
  try {
    return Native.getLocalPort() ?? 0;
  } catch {
    return 0;
  }
};

export const getMeshNodeId = (): string | null => {
  if (!Native) return null;
  try {
    return Native.getNodeId();
  } catch {
    return null;
  }
};

export const getMeshStatus = async (): Promise<MeshStatus | null> => {
  if (!Native) return null;
  try {
    return await Native.getStatus();
  } catch {
    return null;
  }
};

export const joinMeshGroup = async (
  invite: string,
): Promise<MeshJoinResult | null> => {
  if (!Native) return null;
  return await Native.joinGroup(invite.trim());
};

export const leaveMeshGroup = async (group: string): Promise<boolean> => {
  if (!Native) return false;
  return await Native.leaveGroup(group);
};

export const listMeshGroups = async (): Promise<MeshGroup[]> => {
  if (!Native) return [];
  try {
    return await Native.listGroups();
  } catch (error) {
    console.warn("[StingstreamMesh] listGroups failed:", error);
    return [];
  }
};

export const listMeshPeers = async (group?: string): Promise<MeshPeer[]> => {
  if (!Native) return [];
  try {
    return await Native.listPeers(group ?? null);
  } catch (error) {
    console.warn("[StingstreamMesh] listPeers failed:", error);
    return [];
  }
};

/**
 * Hold the node open across a backgrounding, for as long as playback lasts.
 *
 * The player sets this when it starts and clears it when it stops — including on an error path,
 * because a leaked `true` costs battery until the app is next foregrounded.
 */
export const setMeshKeepAwake = (keep: boolean): void => {
  if (!Native) return;
  try {
    Native.setKeepAwake(keep);
  } catch (error) {
    console.warn("[StingstreamMesh] setKeepAwake failed:", error);
  }
};

/**
 * How long the node may stay up in the background with nothing playing.
 *
 * `0` stops it as soon as the app is backgrounded; a negative value never stops it, which is the
 * default on a television.
 */
export const setMeshIdleTimeoutMs = (ms: number): void => {
  if (!Native) return;
  try {
    Native.setIdleTimeoutMs(ms);
  } catch (error) {
    console.warn("[StingstreamMesh] setIdleTimeoutMs failed:", error);
  }
};

export const addMeshPeerOnlineListener = (
  listener: (event: MeshPeerEvent) => void,
): EventSubscription =>
  Native ? Native.addListener("onPeerOnline", listener) : NOOP_SUBSCRIPTION;

export const addMeshPeerOfflineListener = (
  listener: (event: MeshPeerEvent) => void,
): EventSubscription =>
  Native ? Native.addListener("onPeerOffline", listener) : NOOP_SUBSCRIPTION;

export const addMeshStreamStatsListener = (
  listener: (stats: MeshStreamStats) => void,
): EventSubscription =>
  Native ? Native.addListener("onStreamStats", listener) : NOOP_SUBSCRIPTION;

export const addMeshStateListener = (
  listener: (event: MeshStateEvent) => void,
): EventSubscription =>
  Native ? Native.addListener("onMeshState", listener) : NOOP_SUBSCRIPTION;
