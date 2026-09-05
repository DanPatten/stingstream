import { useQuery } from "@tanstack/react-query";
import { useNodeBaseUrl } from "./client";

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

export interface HealthzChild {
  name: string;
  enabled: boolean;
  state: string;
  port: number;
  pid?: number;
  restarts: number;
  base_url: string;
  healthy_since?: string;
  last_exit?: string;
  /**
   * The build this child is running, probed by the supervisor when the child
   * first becomes healthy (M4.5). Absent when the child is disabled, has never
   * answered, or has no way to be asked — all real states, not errors.
   */
  version?: string | null;
}

export interface HealthzResponse {
  status: string;
  node: {
    id: string;
    name: string;
    dev: boolean;
    first_run: boolean;
    data_dir: string;
  };
  gateway: { port: number };
  children: HealthzChild[];
}

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
      return res.json();
    },
    enabled: !!nodeBaseUrl,
    refetchInterval: 5000,
  });
}
