import { useQuery } from "@tanstack/react-query";
import { useNodeBaseUrl } from "./client";
import { type HealthzResponse, normalizeHealthz } from "./healthzShape";

/**
 * `/healthz` is a gateway-level endpoint, not part of StingStream.Core's
 * `/stingstream/api/v1/*` OpenAPI document (see docs/RUNNING.md), so it is
 * not in the generated client. It's a cheap, unauthenticated JSON endpoint —
 * plain `fetch` is enough.
 *
 * Mesh status used to live here too, against the mesh's own raw
 * `/stingstream/mesh/v1/status`. As of M3b that raw surface is
 * localhost-only (it can create groups and mint invite codes with no auth of
 * its own, and the gateway binds 0.0.0.0) — the app now uses
 * `useMeshStatus()` in `lib/stingstream/hooks.ts`, which goes through the
 * generated client against `/stingstream/api/v1/mesh/status` instead
 * (Jellyfin-authenticated, same as everything else this app calls).
 */

export type { HealthzChild, HealthzResponse } from "./healthzShape";
export { normalizeHealthz } from "./healthzShape";

export function useHealthz() {
  const nodeBaseUrl = useNodeBaseUrl();
  return useQuery({
    queryKey: ["stingstream", "healthz", nodeBaseUrl],
    queryFn: async (): Promise<HealthzResponse> => {
      const res = await fetch(`${nodeBaseUrl}/healthz`);
      // /healthz answers 503 while a child is unhealthy but still carries the
      // same JSON body describing which one, so parse either way.
      if (!res.ok && res.status !== 503) {
        throw new Error(`GET /healthz -> ${res.status}`);
      }
      return normalizeHealthz(await res.json());
    },
    enabled: !!nodeBaseUrl,
    refetchInterval: 5000,
  });
}
