import { getItemsApi } from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { READY_REQUEST_REFRESH_MS } from "@/constants/Home";
import { requestAsSearchResult, useRequests } from "@/lib/stingstream/requests";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { hasStartedWatching, recentReadyRequests } from "@/utils/readyRequests";

/** Read actual playback history, including episodes, rather than resume eligibility. */
export function useReadyRequests() {
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const mine = useRequests({ mine: true });
  const candidates = recentReadyRequests(mine.data ?? []);
  return useQuery({
    queryKey: [
      "home",
      "readyRequests",
      api?.basePath,
      user?.Id,
      candidates.map((r) => [r.id, r.localItemId, r.updatedAt]),
    ],
    enabled: !!api && !!user?.Id && !!mine.data,
    queryFn: async () => {
      const current = recentReadyRequests(candidates);
      if (!api || !user?.Id || current.length === 0) return [];
      const itemsApi = getItemsApi(api);
      const response = await itemsApi.getItems({
        userId: user.Id,
        ids: current.map((r) => r.localItemId!),
        enableUserData: true,
        enableImages: false,
      });
      const items = new Map(
        response.data.Items?.map((item) => [item.Id, item]),
      );
      const ready = await Promise.all(
        current.map(async (request) => {
          const item = items.get(request.localItemId!);
          if (!item || hasStartedWatching(item.UserData)) return null;
          if (request.kind === "series") {
            const episodes = await itemsApi.getItems({
              userId: user.Id,
              parentId: item.Id,
              recursive: true,
              includeItemTypes: ["Episode"],
              enableUserData: true,
              enableImages: false,
            });
            if (
              episodes.data.Items?.some((episode) =>
                hasStartedWatching(episode.UserData),
              )
            )
              return null;
          }
          return requestAsSearchResult(request);
        }),
      );
      return ready.filter((result) => result !== null);
    },
    refetchInterval: READY_REQUEST_REFRESH_MS,
    refetchOnMount: "always",
    meta: { persist: false },
  });
}
