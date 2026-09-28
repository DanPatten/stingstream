import type { UserItemDataDto } from "@jellyfin/sdk/lib/generated-client/models";
import { READY_REQUEST_WINDOW_MS } from "@/constants/Home";
import type { MemberRequest } from "@/lib/stingstream/requestsApi";

export function hasStartedWatching(data?: UserItemDataDto | null): boolean {
  return !!(
    data?.Played ||
    data?.LastPlayedDate ||
    (data?.PlayCount ?? 0) > 0 ||
    (data?.PlaybackPositionTicks ?? 0) > 0
  );
}

export function recentReadyRequests(
  requests: readonly MemberRequest[],
  now = Date.now(),
): MemberRequest[] {
  return requests
    .filter((request) => {
      const availableAt = Date.parse(request.updatedAt);
      return (
        request.state === "available" &&
        !!request.localItemId &&
        Number.isFinite(availableAt) &&
        availableAt <= now &&
        now - availableAt < READY_REQUEST_WINDOW_MS
      );
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
