import {
  getLibraryStructureApi,
  getScheduledTasksApi,
} from "@jellyfin/sdk/lib/utils/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { useIsStingStreamAdmin } from "@/components/stingstream/shared/RequiresAdmin";
import {
  SCAN_POLL_ACTIVE_MS,
  SCAN_POLL_IDLE_MS,
  SCAN_REFRESH_ITEMS_MS,
} from "@/constants/Library";
import { useNetworkAwareQueryClient } from "@/hooks/useNetworkAwareQueryClient";
import {
  holdHighest,
  IDLE_SCAN,
  type ScanSummary,
  summarizeScan,
} from "@/lib/stingstream/scanStatus";
import { apiAtom } from "@/providers/JellyfinProvider";
import {
  LIBRARY_CHANGE_QUERY_KEYS,
  useWebSocketContext,
} from "@/providers/WebSocketProvider";

export const SCAN_STATUS_QUERY_KEY = ["scan-status"] as const;

/**
 * Whether a library scan is running, and how far it has got.
 *
 * Administrators only: both endpoints behind it require it, and so does the socket message that
 * says a scan has started. Everybody else gets `IDLE_SCAN`, which draws nothing.
 *
 * Every caller shares one query, so a list of libraries and the pill on the page above it cost
 * one pair of requests between them.
 */
export function useScanStatus(): ScanSummary {
  const api = useAtomValue(apiAtom);
  const isAdmin = useIsStingStreamAdmin();
  const queryClient = useQueryClient();
  const { subscribe } = useWebSocketContext();
  const highest = useRef(new Map<string, number>());

  const query = useQuery({
    queryKey: SCAN_STATUS_QUERY_KEY,
    queryFn: async () => {
      if (!api) return IDLE_SCAN;
      const [folders, tasks] = await Promise.all([
        getLibraryStructureApi(api).getVirtualFolders(),
        getScheduledTasksApi(api).getTasks({ isHidden: false }),
      ]);
      return summarizeScan(folders.data, tasks.data);
    },
    enabled: !!api && isAdmin,
    refetchInterval: (q) =>
      q.state.data?.active ? SCAN_POLL_ACTIVE_MS : SCAN_POLL_IDLE_MS,
    // A failed read is not a scan. Say nothing rather than retry into a spinner.
    retry: false,
    // Never shown from a persisted cache: a scan from last session is not running now.
    gcTime: 0,
  });

  // A scan started from anywhere (this page, another device, the server's own schedule) is pushed
  // to administrators as `RefreshProgress`. Refetch then rather than wait out the idle interval.
  useEffect(() => {
    if (!isAdmin) return;
    const wake = () => {
      const state = queryClient.getQueryState(SCAN_STATUS_QUERY_KEY);
      const data = state?.data as ScanSummary | undefined;
      if (data?.active) return;
      if (state?.fetchStatus === "fetching") return;
      queryClient.invalidateQueries({ queryKey: SCAN_STATUS_QUERY_KEY });
    };
    const unsubscribe = [
      subscribe("RefreshProgress", wake),
      subscribe("ScheduledTaskEnded", () =>
        queryClient.invalidateQueries({ queryKey: SCAN_STATUS_QUERY_KEY }),
      ),
    ];
    return () => {
      for (const off of unsubscribe) off();
    };
  }, [isAdmin, queryClient, subscribe]);

  return useMemo(
    () => holdHighest(query.data ?? IDLE_SCAN, highest.current),
    [query.data],
  );
}

/** When the item lists were last refetched for a scan, across every mounted caller. */
let lastItemRefresh = 0;

/**
 * Refetch the home rows and library grids while a scan runs, and once more when it ends.
 *
 * So movies, and then their posters, appear as the scan finds them rather than all at once when
 * it is over. See `SCAN_REFRESH_ITEMS_MS` for why the server's own push does not do this.
 *
 * Several screens can be mounted at once (tabs stay mounted), so the timestamp is shared: the
 * first caller to reach the interval refetches and the rest see it was just done.
 */
export function useRefreshItemsWhileScanning(active: boolean): void {
  const queryClient = useNetworkAwareQueryClient();
  const wasActive = useRef(active);

  useEffect(() => {
    const refresh = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastItemRefresh < SCAN_REFRESH_ITEMS_MS / 2) return;
      lastItemRefresh = now;
      for (const queryKey of LIBRARY_CHANGE_QUERY_KEYS) {
        // Not cancelling a fetch already under way: it is already bringing what this would.
        queryClient.invalidateQueries(
          { queryKey: [...queryKey] },
          { cancelRefetch: false },
        );
      }
    };

    if (!active) {
      if (wasActive.current) refresh(true);
      wasActive.current = false;
      return;
    }

    wasActive.current = true;
    const timer = setInterval(() => refresh(false), SCAN_REFRESH_ITEMS_MS);
    return () => clearInterval(timer);
  }, [active, queryClient]);
}
