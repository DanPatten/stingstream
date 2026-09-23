import NetInfo from "@react-native-community/netinfo";
import { useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";
import { apiAtom } from "@/providers/JellyfinProvider";
import {
  decideServerState,
  NODE_STATE_HEADER,
  nextPollDelay,
  type ProbeReading,
  readProbeResponse,
  type ServerState,
  type ServerWait,
} from "@/utils/jellyfin/serverReadiness";

interface NetworkStatusContextType {
  isConnected: boolean;
  /**
   * The old three-way answer, kept for the callers that only need "usable or not": `true` when
   * ready, `false` when stalled or unreachable, `null` while checking or starting.
   */
  serverConnected: boolean | null;
  /** What to show about the server. See `ServerState`. */
  serverState: ServerState;
  /**
   * True until the server has been seen ready once since the app loaded. While it is, and the
   * server is starting or stalled, the signed-in shell shows the starting screen in place of every
   * tab rather than letting each one fail on its own.
   */
  startingUp: boolean;
  loading: boolean;
  retryCheck: () => Promise<void>;
}

const NetworkStatusContext = createContext<NetworkStatusContextType | null>(
  null,
);

/** A slow LAN answers in well under this; a hung connection does not answer at all. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Ask the canonical unauthenticated endpoint (/System/Info/Public) whether the server is there and
 * ready, instead of a HEAD on the server root: subpath reverse proxies, auth-gated web roots and
 * HEAD-blocking setups made the root check report the server offline while the API worked fine,
 * leaving the home screen empty (#1257).
 *
 * `fetch` rather than axios so that a non-2xx is a response to read rather than an exception to
 * catch: the 503 a node sends while it starts is the whole point.
 */
async function probeReadiness(basePath: string): Promise<ProbeReading> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${basePath}/System/Info/Public`, {
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text().catch(() => "");
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: the reading says so.
    }
    return readProbeResponse({
      status: response.status,
      stateHeader: response.headers.get(NODE_STATE_HEADER),
      body,
    });
  } catch {
    return readProbeResponse({ networkError: true });
  } finally {
    clearTimeout(timer);
  }
}

function connectedFor(state: ServerState): boolean | null {
  if (state === "ok") return true;
  if (state === "stalled" || state === "unreachable") return false;
  return null;
}

export function NetworkStatusProvider({ children }: { children: ReactNode }) {
  const [isConnected, setIsConnected] = useState(true);
  // Optimistic: a launch with a working server should not flash a checking screen first.
  const [serverState, setServerState] = useState<ServerState>("ok");
  const [startingUp, setStartingUp] = useState(true);
  const [loading, setLoading] = useState(false);
  const [api] = useAtom(apiAtom);
  const queryClient = useQueryClient();

  // The current stretch of not-ok answers, and how many polls it has made. Null while ready.
  const waitRef = useRef<ServerWait | null>(null);
  const attemptRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenReadyRef = useRef(false);
  const basePathRef = useRef(api?.basePath);
  basePathRef.current = api?.basePath;

  const cancelPoll = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
  }, []);

  const validateConnection = useCallback(
    async (options: { fresh?: boolean } = {}): Promise<boolean> => {
      const basePath = api?.basePath;
      if (!basePath) return false;
      cancelPoll();
      if (options.fresh) {
        // Try again starts a new wait with a full budget. It gets no grace: somebody who pressed
        // it after "unreachable" wants to know, not to watch another spinner.
        waitRef.current = null;
        attemptRef.current = 0;
      }

      const reading = await probeReadiness(basePath);
      // The server changed while this was in flight; its answer is about somewhere else.
      if (basePathRef.current !== basePath) return false;

      if (reading === "ok") {
        waitRef.current = null;
        attemptRef.current = 0;
        seenReadyRef.current = true;
        setStartingUp(false);
        setServerState("ok");
        return true;
      }

      const now = Date.now();
      if (!waitRef.current) {
        waitRef.current = {
          since: now,
          answered: false,
          graceful:
            !options.fresh && Platform.OS === "web" && !seenReadyRef.current,
        };
      }
      if (reading === "starting" || reading === "failed") {
        waitRef.current.answered = true;
      }
      const state = decideServerState(reading, waitRef.current, now);
      setServerState(state);

      // Keep asking, so the screen moves on by itself the moment the server is ready.
      const delay = nextPollDelay(state, attemptRef.current);
      attemptRef.current += 1;
      if (delay !== null) {
        pollRef.current = setTimeout(() => {
          pollRef.current = null;
          void validateConnection();
        }, delay);
      }
      return false;
    },
    [api?.basePath, cancelPoll],
  );

  const retryCheck = useCallback(async () => {
    setLoading(true);
    await validateConnection({ fresh: true });
    setLoading(false);
  }, [validateConnection]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(async (state) => {
      setIsConnected(!!state.isConnected);
      if (state.isConnected) {
        await validateConnection();
      } else {
        cancelPoll();
        setServerState("unreachable");
      }
    });

    // Initial check
    NetInfo.fetch().then((state) => {
      if (state.isConnected) {
        validateConnection();
      } else {
        setServerState("unreachable");
      }
    });

    return () => {
      unsubscribe();
      cancelPoll();
    };
  }, [validateConnection, cancelPoll]);

  // Refetch active queries when the server becomes ready after not being, so the screens that
  // failed against a starting server fill in without a manual refresh.
  const previousState = useRef<ServerState>(serverState);
  useEffect(() => {
    if (serverState === "ok" && previousState.current !== "ok") {
      queryClient.refetchQueries({ type: "active" });
    }
    previousState.current = serverState;
  }, [serverState, queryClient]);

  return (
    <NetworkStatusContext.Provider
      value={{
        isConnected,
        serverConnected: connectedFor(serverState),
        serverState,
        startingUp,
        loading,
        retryCheck,
      }}
    >
      {children}
    </NetworkStatusContext.Provider>
  );
}

export function useNetworkStatus(): NetworkStatusContextType {
  const context = useContext(NetworkStatusContext);
  if (!context) {
    throw new Error(
      "useNetworkStatus must be used within NetworkStatusProvider",
    );
  }
  return context;
}
