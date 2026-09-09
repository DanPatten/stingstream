import { useAtomValue } from "jotai";
import type React from "react";
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
import { Platform } from "react-native";
import { useKnownServers } from "@/hooks/useKnownServers";
import { useWifiSSID } from "@/hooks/useWifiSSID";
import {
  useMeshSharingSettings,
  useNodeMeshStatus,
} from "@/lib/stingstream/mesh";
import {
  ownAddressRecord,
  raceSideDoor,
  type SideDoorChoice,
  type SideDoorRecord,
} from "@/lib/stingstream/sidedoor";
import { apiAtom, useJellyfin } from "@/providers/JellyfinProvider";
import { storage } from "@/utils/mmkv";
import { getServerLocalConfig } from "@/utils/secureCredentials";

interface ServerUrlContextValue {
  effectiveServerUrl: string | null;
  isUsingLocalUrl: boolean;
  currentSSID: string | null;
  connectedToWifi: boolean;
  refreshUrlState: () => void;
  /**
   * The HTTPS side-door hostname this browser raced to, on the web build only.
   *
   * `null` everywhere else: a native build reaches its home node over the mesh and has no use for
   * a public hostname, and a node with no coordinator publishes none. `warning` is set for the
   * DNS-rebinding fallback, which is a plain-HTTP connection and has to be shown as one.
   */
  sideDoor: SideDoorChoice | null;
}

const ServerUrlContext = createContext<ServerUrlContextValue | null>(null);

const DEBOUNCE_MS = 500;

interface Props {
  children: ReactNode;
}

export function ServerUrlProvider({ children }: Props): React.ReactElement {
  const api = useAtomValue(apiAtom);
  const { switchServerUrl } = useJellyfin();
  const { ssid, connectedToWifi, permissionStatus } = useWifiSSID();

  const [isUsingLocalUrl, setIsUsingLocalUrl] = useState(false);
  const [effectiveServerUrl, setEffectiveServerUrl] = useState<string | null>(
    null,
  );

  const [sideDoor, setSideDoor] = useState<SideDoorChoice | null>(null);

  const remoteUrlRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSSIDRef = useRef<string | null>(null);

  // Sync remoteUrl from storage when api changes
  useEffect(() => {
    const storedUrl = storage.getString("serverUrl");
    if (storedUrl) {
      remoteUrlRef.current = storedUrl;
    }
    if (api?.basePath && !effectiveServerUrl) {
      setEffectiveServerUrl(api.basePath);
    }
  }, [api?.basePath, effectiveServerUrl]);

  // Function to evaluate and switch URL based on current config and SSID
  const evaluateAndSwitchUrl = useCallback(() => {
    const remoteUrl = remoteUrlRef.current;
    if (!remoteUrl || !switchServerUrl) return;

    const config = getServerLocalConfig(remoteUrl);
    const shouldUseLocal = Boolean(
      config?.enabled &&
        config.localUrl &&
        ssid !== null &&
        config.homeWifiSSIDs.includes(ssid),
    );

    const targetUrl = shouldUseLocal ? config!.localUrl : remoteUrl;

    switchServerUrl(targetUrl);
    setIsUsingLocalUrl(shouldUseLocal);
    setEffectiveServerUrl(targetUrl);
  }, [ssid, switchServerUrl]);

  // Manual refresh function for when config changes
  const refreshUrlState = useCallback(() => {
    evaluateAndSwitchUrl();
  }, [evaluateAndSwitchUrl]);

  // --- the HTTPS side door, web bundle only --------------------------------------------------
  //
  // A native build dials its home node over the mesh, so none of this applies to it. A browser
  // cannot, and the address it should use depends on where it is standing: the machine itself at
  // home, the owner's own domain away. Racing is faster and more reliable than guessing, and the
  // winner is remembered per network, so this normally costs one request per load.
  //
  // The only candidate is the address the node's owner set under Sharing. A node without one is
  // reachable on its own network and through the app's mesh, and not from a browser elsewhere --
  // see `docs/SIDEDOOR.md`.
  // Learn where this server and its linked servers can be reached, so a later cold load with a
  // dead origin has somewhere to go instead of a question. Writes only; nothing here renders from
  // it. See `lib/stingstream/knownServers.ts`.
  useKnownServers();

  const { data: meshStatus } = useNodeMeshStatus();
  const { data: sharing } = useMeshSharingSettings();
  const racedNodeRef = useRef<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = meshStatus?.node;
    if (!node || !switchServerUrl) return;
    // Once per node per session. Re-racing on every render of a query that polls every fifteen
    // seconds would open three connections a minute for no benefit.
    if (racedNodeRef.current === node) return;
    racedNodeRef.current = node;

    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      // The node's own address, when its owner has set one. Nothing else can be raced now: the
      // three coordinator-issued hostnames went with the coordinator, so a node with no domain is
      // simply not reachable from a browser away from home, and racing would say so slowly.
      const record: SideDoorRecord | null = ownAddressRecord(
        node,
        sharing?.publicAddress,
      );
      if (!record || cancelled) return;

      const choice = await raceSideDoor(record, { signal: controller.signal });
      if (!choice || cancelled) return;
      setSideDoor(choice);

      // Switch only when the winner is somewhere else. The common case is a browser that already
      // loaded the app from the winning hostname, and re-pointing the API at the address it is
      // already using would drop and rebuild the connection for nothing.
      const target = `${choice.url}/jellyfin`;
      if (api?.basePath && api.basePath.replace(/\/+$/, "") !== target) {
        switchServerUrl(target);
        setEffectiveServerUrl(target);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    meshStatus?.node,
    sharing?.publicAddress,
    switchServerUrl,
    api?.basePath,
  ]);

  // Debounced SSID change handler
  useEffect(() => {
    if (permissionStatus !== "granted") return;
    if (ssid === lastSSIDRef.current) return;

    lastSSIDRef.current = ssid;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      evaluateAndSwitchUrl();
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [ssid, permissionStatus, evaluateAndSwitchUrl]);

  const value = useMemo(
    () => ({
      effectiveServerUrl,
      isUsingLocalUrl,
      currentSSID: ssid,
      connectedToWifi,
      refreshUrlState,
      sideDoor,
    }),
    [
      effectiveServerUrl,
      isUsingLocalUrl,
      ssid,
      connectedToWifi,
      refreshUrlState,
      sideDoor,
    ],
  );

  return (
    <ServerUrlContext.Provider value={value}>
      {children}
    </ServerUrlContext.Provider>
  );
}

export function useServerUrl(): ServerUrlContextValue {
  const context = useContext(ServerUrlContext);
  if (!context) {
    throw new Error("useServerUrl must be used within ServerUrlProvider");
  }
  return context;
}
