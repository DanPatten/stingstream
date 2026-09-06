import type { MediaSourceInfo } from "@jellyfin/sdk/lib/generated-client/models";
import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import { useAtomValue } from "jotai";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { fetchMeshGroups, fetchMeshInvite } from "@/lib/stingstream/mesh";
import {
  addMeshPeerOfflineListener,
  addMeshPeerOnlineListener,
  addMeshStateListener,
  addMeshStreamStatsListener,
  getMeshLocalPort,
  getMeshStatus,
  isMeshAvailable,
  isMeshRunning,
  joinMeshGroup,
  leaveMeshGroup,
  listMeshGroups,
  listMeshPeers,
  type MeshGroup,
  type MeshPeer,
  type MeshStatus,
  type MeshStreamStats,
  startMesh,
  stopMesh,
} from "@/modules/stingstream-mesh";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import {
  clearMeshRewriteContext,
  parseMeshStreamUrl,
  setMeshRewriteContext,
} from "@/utils/mesh/streamUrl";

/**
 * The app's embedded light node: start it, keep its group membership in step with the home node's,
 * and publish the two facts the URL rewrite needs (the loopback port and which groups are joined).
 *
 * ## Auto-membership
 *
 * A user does not join groups on their phone. They join them on their *node*, and the phone
 * follows: after login this provider reads `GET /stingstream/mesh/v1/groups` from the home node,
 * mints an invite for each with `POST /stingstream/mesh/v1/groups/{id}/invite`, and hands those to
 * the embedded node. The result is that a phone is a light member of exactly the groups its home
 * node belongs to — no more, and no fewer, so a group the node has left stops being dialled from
 * the phone too.
 *
 * Minting an invite to oneself looks odd until you notice that an invite code is the only thing
 * that carries a group's *secret*, and the secret is what gates every peer connection. There is no
 * "export my membership" endpoint because an invite already is one.
 *
 * ## Why the sync runs more than once
 *
 * On login, on every foreground, and on a slow timer. A group created on the node while the app
 * was in someone's pocket would otherwise stay invisible until the app was killed and restarted,
 * which is exactly the moment a user is standing in front of the TV wondering why.
 */

export type MeshConnectionKind =
  | "direct"
  | "relayed"
  | "home-node"
  | "connecting";

export interface MeshSourceStatus {
  kind: MeshConnectionKind;
  /** A short label for the player's info overlay. */
  label: string;
  /** The holder's name, when the mesh knows it. */
  nodeName: string | null;
  rttMs: number | null;
}

export interface MeshContextValue {
  /** The native module exists (Android and Android TV only). */
  available: boolean;
  running: boolean;
  status: MeshStatus | null;
  /** Groups the *embedded* node has joined. */
  groups: MeshGroup[];
  peers: MeshPeer[];
  /** The last `/stream` response, per source node. Feeds the player's status pill. */
  lastStats: Record<string, MeshStreamStats>;
  /** Errors from the last membership sync, for the Group screen to show. */
  syncError: string | null;
  syncing: boolean;
  /** Re-read groups and peers from the embedded node. */
  refresh: () => Promise<void>;
  /** Re-run the membership sync against the home node. */
  syncGroups: () => Promise<void>;
}

const EMPTY: MeshContextValue = {
  available: false,
  running: false,
  status: null,
  groups: [],
  peers: [],
  lastStats: {},
  syncError: null,
  syncing: false,
  refresh: async () => {},
  syncGroups: async () => {},
};

const MeshContext = createContext<MeshContextValue>(EMPTY);

/** How often to re-check the home node's group list while the app is in the foreground. */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
/** How often to re-read peers, which is what greys a member out in the Group screen. */
const PEER_POLL_MS = 15_000;

export function MeshProvider({ children }: { children: ReactNode }) {
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<MeshStatus | null>(null);
  const [groups, setGroups] = useState<MeshGroup[]>([]);
  const [peers, setPeers] = useState<MeshPeer[]>([]);
  const [lastStats, setLastStats] = useState<Record<string, MeshStreamStats>>(
    {},
  );
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const available = isMeshAvailable();
  // A sync is a burst of network calls against the home node; two at once achieve nothing.
  const syncInFlight = useRef(false);

  // `/stingstream/api/v1`, i.e. StingStream.Core behind Jellyfin's auth — not the mesh's raw
  // loopback API, which the gateway refuses from anywhere but the node itself.
  const apiBaseUrl = api?.basePath
    ? getStingStreamApiBaseUrl(api.basePath)
    : null;
  const accessToken = api?.accessToken ?? null;
  const loggedIn = !!apiBaseUrl && !!user?.Id;

  // --- publishing what the URL rewrite reads ----------------------------------------------

  useEffect(() => {
    if (!available || !running) {
      clearMeshRewriteContext();
      return;
    }
    setMeshRewriteContext({
      available: true,
      localPort: getMeshLocalPort(),
      groups: groups.map((g) => g.id),
    });
  }, [available, running, groups]);

  useEffect(() => () => clearMeshRewriteContext(), []);

  // --- reading the embedded node -----------------------------------------------------------

  const refresh = useCallback(async () => {
    if (!available) return;
    const [nextStatus, nextGroups, nextPeers] = await Promise.all([
      getMeshStatus(),
      listMeshGroups(),
      listMeshPeers(),
    ]);
    setStatus(nextStatus);
    setGroups(nextGroups);
    setPeers(nextPeers);
    setRunning(!!nextStatus && nextStatus.localPort > 0);
  }, [available]);

  // --- the membership sync -------------------------------------------------------------------

  const syncGroups = useCallback(async () => {
    if (!available || !apiBaseUrl || syncInFlight.current) return;
    // Nothing to sync into. Without this, a build whose native library failed to start would
    // fetch the node's groups, fail to join every one of them, and put a wall of errors on the
    // Group screen — where the honest answer is the one `DeviceMeshSection` already gives:
    // the embedded node is not running and the home node is proxying.
    if (!isMeshRunning()) return;
    syncInFlight.current = true;
    setSyncing(true);
    try {
      const [nodeGroups, mine] = await Promise.all([
        fetchMeshGroups(apiBaseUrl, accessToken),
        listMeshGroups(),
      ]);

      const wanted = new Set(nodeGroups.map((g) => g.group.toLowerCase()));
      const held = new Set(mine.map((g) => g.id.toLowerCase()));
      const failures: string[] = [];

      // Join anything the node belongs to and this device does not.
      for (const group of nodeGroups) {
        if (held.has(group.group.toLowerCase())) continue;
        try {
          const code = await fetchMeshInvite(
            apiBaseUrl,
            group.group,
            accessToken,
          );
          await joinMeshGroup(code);
        } catch (error) {
          // One group failing must not stop the rest: a phone that can reach three of its four
          // groups should be in three of them, not none.
          failures.push(`${group.name}: ${(error as Error).message}`);
        }
      }

      // And leave anything the node has left, so the phone stops dialling a group it is no
      // longer trusted in.
      for (const group of mine) {
        if (wanted.has(group.id.toLowerCase())) continue;
        try {
          await leaveMeshGroup(group.id);
        } catch (error) {
          failures.push(`leaving ${group.name}: ${(error as Error).message}`);
        }
      }

      setSyncError(failures.length ? failures.join("\n") : null);
      await refresh();
    } catch (error) {
      setSyncError((error as Error).message);
    } finally {
      syncInFlight.current = false;
      setSyncing(false);
    }
  }, [available, apiBaseUrl, accessToken, refresh]);

  // --- lifecycle -------------------------------------------------------------------------------

  // Start after login, not on mount: before login there is no node to follow, and an endpoint
  // with no groups is a socket and two threads spent on nothing.
  useEffect(() => {
    if (!available || !loggedIn) return;
    let cancelled = false;
    (async () => {
      const started = await startMesh();
      if (cancelled) return;
      if (!started) {
        // The module exists but the node would not come up — a missing native library, or a
        // data directory the OS would not let us write. `DeviceMeshSection` says so; there is
        // nothing to join groups into.
        setRunning(false);
        return;
      }
      setStatus(started);
      setRunning(started.localPort > 0);
      await syncGroups();
    })();
    return () => {
      cancelled = true;
    };
  }, [available, loggedIn, syncGroups]);

  // Logging out stops the node — there is no home node to follow, and leaving a QUIC socket and
  // two worker threads up on a phone for nobody is exactly the sort of thing that shows up in a
  // battery report a week later. Group membership survives in `mesh.db`, so the next login is a
  // no-op sync rather than a re-join of everything.
  //
  // Also runs once before the first login, where `stopMesh()` is a no-op.
  useEffect(() => {
    if (available && !loggedIn) {
      setRunning(false);
      setGroups([]);
      setPeers([]);
      clearMeshRewriteContext();
      void stopMesh();
    }
  }, [available, loggedIn]);

  useEffect(() => {
    if (!available || !running) return;
    const timer = setInterval(() => {
      void listMeshPeers().then(setPeers);
    }, PEER_POLL_MS);
    return () => clearInterval(timer);
  }, [available, running]);

  useEffect(() => {
    if (!available || !loggedIn) return;
    const timer = setInterval(() => void syncGroups(), SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [available, loggedIn, syncGroups]);

  useEffect(() => {
    if (!available || !loggedIn) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void syncGroups();
    });
    return () => sub.remove();
  }, [available, loggedIn, syncGroups]);

  // --- native events ---------------------------------------------------------------------------

  useEffect(() => {
    if (!available) return;
    const subscriptions = [
      addMeshPeerOnlineListener(() => void listMeshPeers().then(setPeers)),
      addMeshPeerOfflineListener(() => void listMeshPeers().then(setPeers)),
      addMeshStreamStatsListener((stats) =>
        setLastStats((prev) => ({ ...prev, [stats.node]: stats })),
      ),
      addMeshStateListener((event) => {
        setRunning(event.state === "running");
        if (event.state === "running") void refresh();
      }),
    ];
    return () => {
      for (const sub of subscriptions) sub.remove();
    };
  }, [available, refresh]);

  const value = useMemo<MeshContextValue>(
    () => ({
      available,
      running,
      status,
      groups,
      peers,
      lastStats,
      syncError,
      syncing,
      refresh,
      syncGroups,
    }),
    [
      available,
      running,
      status,
      groups,
      peers,
      lastStats,
      syncError,
      syncing,
      refresh,
      syncGroups,
    ],
  );

  return <MeshContext.Provider value={value}>{children}</MeshContext.Provider>;
}

export const useMesh = (): MeshContextValue => useContext(MeshContext);

/**
 * How the currently-playing source is reaching this device, for the player's info overlay.
 *
 * `null` when the source is not a mesh source at all — an ordinary local file, or a transcode —
 * because a pill saying "home node" over every normal playback would be noise.
 */
export function useMeshSourceStatus(
  mediaSource: MediaSourceInfo | null | undefined,
): MeshSourceStatus | null {
  const { available, running, groups, peers, lastStats } = useMesh();

  return useMemo(() => {
    const target = parseMeshStreamUrl(mediaSource?.Path);
    if (!target) return null;

    const joined = groups.some(
      (g) => g.id.toLowerCase() === target.group.toLowerCase(),
    );
    if (!available || !running || !joined) {
      // The URL was left alone, so the home node's gateway is proxying it through its own mesh.
      return {
        kind: "home-node",
        label: "Via your server",
        nodeName: null,
        rttMs: null,
      };
    }

    const peer = peers.find(
      (p) =>
        p.node.toLowerCase() === target.node.toLowerCase() &&
        p.group.toLowerCase() === target.group.toLowerCase(),
    );
    // The stats callback is the fresher of the two: `peers` is a table the mesh updates when a
    // connection is made, while a stat is the path the last range actually took.
    const path = lastStats[target.node]?.path ?? peer?.path ?? null;
    const rttMs = lastStats[target.node]?.rttMs ?? peer?.rttMs ?? null;
    const nodeName = peer?.nodeName ?? null;

    if (path === "direct" || path === "mixed") {
      return { kind: "direct", label: "Direct", nodeName, rttMs };
    }
    if (path === "relay") {
      return { kind: "relayed", label: "Relayed", nodeName, rttMs };
    }
    return { kind: "connecting", label: "Connecting", nodeName, rttMs };
  }, [mediaSource?.Path, available, running, groups, peers, lastStats]);
}
