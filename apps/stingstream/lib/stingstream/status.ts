import { useQuery } from "@tanstack/react-query";
import { useNodeBaseUrl } from "./client";

/**
 * `/healthz` and the mesh's own `/stingstream/mesh/v1/status` are gateway-level
 * endpoints, not part of StingStream.Core's `/stingstream/api/v1/*` OpenAPI
 * document (see docs/RUNNING.md), so they are not in the generated client.
 * Both are cheap, unauthenticated JSON endpoints — plain `fetch` is enough.
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

export interface MeshStatusResponse {
  node: string;
  node_name: string;
  version: string;
  groups: number;
  available_streams: number;
  relay_urls: string[];
  direct_addrs: string[];
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

export function useMeshStatus() {
  const nodeBaseUrl = useNodeBaseUrl();
  return useQuery({
    queryKey: ["stingstream", "mesh-status", nodeBaseUrl],
    queryFn: async (): Promise<MeshStatusResponse> => {
      const res = await fetch(`${nodeBaseUrl}/stingstream/mesh/v1/status`);
      if (!res.ok)
        throw new Error(`GET /stingstream/mesh/v1/status -> ${res.status}`);
      return res.json();
    },
    enabled: !!nodeBaseUrl,
    refetchInterval: 10000,
    // M3 mesh work is landing alongside M2; older nodes with no mesh child
    // simply won't answer this, so a failure here is not fatal to the screen.
    retry: 1,
  });
}
