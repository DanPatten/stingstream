import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { apiAtom } from "@/providers/JellyfinProvider";

/**
 * The **home node's** mesh, as the app reaches it: `/stingstream/api/v1/mesh/*`, which is
 * `StingStream.Core`'s `MeshController` sitting in front of the mesh's own loopback API with
 * Jellyfin's authentication on it.
 *
 * Not the mesh's raw `/stingstream/mesh/v1/*`. That surface can create groups and mint invite
 * codes with no credential of its own — it is bound to `127.0.0.1` precisely because anything that
 * can reach it is already on the machine — and since M3b the gateway refuses it from anywhere but
 * loopback. A phone gets a `403` there and this route instead.
 *
 * Two different meshes are in play and it is worth being precise about which is which:
 *
 *  * **the home node's** — a full node. It holds the library, the group secrets and the
 *    connections to everyone. This file talks to that one.
 *  * **the app's own** — a light node inside this process, `@/modules/stingstream-mesh`. It joins
 *    the same groups so playback can dial holders directly, and does nothing else.
 *
 * `MeshProvider` is what connects them: it reads the groups from here, asks for an invite to each,
 * and feeds those to the light node.
 *
 * **Elevation.** Reading (groups, peers, status) needs any Jellyfin account. Creating, joining,
 * inviting and leaving are `RequiresElevation` — a group is the *node's* identity in the mesh, not
 * a per-user setting — so the screens hide those actions for a non-administrator rather than
 * offering a button that answers 403.
 *
 * Hand-written rather than generated: `packages/api-client`'s snapshot of the OpenAPI document
 * predates `MeshController`, and regenerating it needs a live node.
 */

/**
 * `GET /mesh/groups`, and the body of `POST /mesh/groups`.
 *
 * Every nullable field here is **optional**, not `T | null`: Core omits nulls from its JSON
 * rather than serialising them, so a group with no coordinator has no `coordinator` key at all.
 * Typing it as `string | null` would let code assume the key is present.
 */
export interface MeshNodeGroup {
  group: string;
  name: string;
  /**
   * Absent for the zero-server default. The mesh normalises what it stores — `https://host`
   * comes back as `https://host/` — so never compare this to what a user typed.
   */
  coordinator?: string | null;
  createdAt: string;
}

/** `GET /mesh/peers`. Nulls are omitted, so every optional field may simply be missing. */
export interface MeshNodePeer {
  group: string;
  node: string;
  nodeName: string;
  online: boolean;
  firstSeen: string;
  lastSeen?: string | null;
  /** `direct`, `relay`, `mixed`, or absent when nothing has connected yet. */
  path?: string | null;
  rttMs?: number | null;
  maxDirectStreams?: number | null;
  maxTranscodes?: number | null;
  activeDirectStreams?: number | null;
  activeTranscodes?: number | null;
  freeSpace?: number | null;
}

/** `GET /mesh/status`. */
export interface MeshNodeStatus {
  node: string;
  nodeName: string;
  version: string;
  groups: number;
  availableStreams: number;
  relayUrls: string[];
  directAddrs: string[];
}

export interface MeshInvite {
  code: string;
}

export interface MeshJoinResponse {
  group: string;
  name: string;
  coordinator?: string | null;
  via: "inviter" | "rendezvous" | "none";
  contacted: string[];
}

/**
 * Read whatever the node said went wrong.
 *
 * Core answers `{"error": "…"}` carrying the mesh's own context chain, and Jellyfin answers a
 * ProblemDetails object; a proxy in between may answer neither. All three end up as one sentence
 * the Group screen can show.
 */
export class MeshUnavailableError extends Error {
  readonly unavailable = true;
}

const readError = async (res: Response, what: string): Promise<Error> => {
  if (res.status === 401 || res.status === 403) {
    return new Error(
      `${what}: this needs a Jellyfin administrator account on the home node.`,
    );
  }
  // Core answers 503 when it cannot reach the mesh child, rather than an empty result — because
  // "no groups" and "I could not ask" look identical in a body and mean opposite things. On the
  // node side that distinction stops the federated materializer deleting every pointer during a
  // mesh restart; here it stops the Group screen telling the user they belong to nothing.
  if (res.status === 503) {
    return new MeshUnavailableError(
      "This node's mesh isn't answering. Groups and peers are unavailable until it comes back; playback still works through the home node.",
    );
  }
  let detail = `${res.status}`;
  try {
    const body = await res.json();
    if (typeof body?.error === "string") detail = body.error;
    else if (typeof body?.title === "string") detail = body.title;
  } catch {
    // A non-JSON body leaves the status as the message.
  }
  return new Error(`${what}: ${detail}`);
};

/** The Jellyfin token the whole app already uses; Core's auth *is* Jellyfin's auth. */
const authHeaders = (
  token: string | null | undefined,
): Record<string, string> =>
  token ? { Authorization: `MediaBrowser Token="${token}"` } : {};

const useMeshApi = () => {
  const api = useAtomValue(apiAtom);
  const base = api?.basePath ? getStingStreamApiBaseUrl(api.basePath) : null;
  const token = api?.accessToken ?? null;

  return {
    base,
    request: async <T>(
      path: string,
      init?: RequestInit & { expectNoContent?: boolean },
    ): Promise<T> => {
      if (!base) throw new Error("no node is connected");
      const { expectNoContent, ...rest } = init ?? {};
      const res = await fetch(`${base}/mesh${path}`, {
        ...rest,
        headers: {
          ...(rest.body ? { "Content-Type": "application/json" } : {}),
          ...authHeaders(token),
          ...(rest.headers ?? {}),
        },
      });
      if (!res.ok)
        throw await readError(res, `${rest.method ?? "GET"} ${path}`);
      if (expectNoContent || res.status === 204) return undefined as T;
      return (await res.json()) as T;
    },
  };
};

export const MESH_QUERY_KEY = ["stingstream", "mesh"] as const;

/** The groups the home node belongs to. */
export function useNodeMeshGroups(): UseQueryResult<MeshNodeGroup[]> {
  const { base, request } = useMeshApi();
  return useQuery({
    queryKey: [...MESH_QUERY_KEY, "groups", base],
    queryFn: () => request<MeshNodeGroup[]>("/groups"),
    enabled: !!base,
    // Membership changes rarely; the peer list below is what needs to be fresh.
    refetchInterval: 30_000,
  });
}

/** Members of one group as the *home node* sees them, with liveness and path. */
export function useNodeMeshPeers(
  group: string | null | undefined,
): UseQueryResult<MeshNodePeer[]> {
  const { base, request } = useMeshApi();
  return useQuery({
    queryKey: [...MESH_QUERY_KEY, "peers", base, group ?? "all"],
    queryFn: () =>
      request<MeshNodePeer[]>(
        group ? `/peers?group=${encodeURIComponent(group)}` : "/peers",
      ),
    enabled: !!base,
    refetchInterval: 10_000,
  });
}

export function useNodeMeshStatus(): UseQueryResult<MeshNodeStatus> {
  const { base, request } = useMeshApi();
  return useQuery({
    queryKey: [...MESH_QUERY_KEY, "status", base],
    queryFn: () => request<MeshNodeStatus>("/status"),
    enabled: !!base,
    refetchInterval: 15_000,
    retry: 1,
  });
}

/**
 * Create a group on the home node. Administrator only.
 *
 * The coordinator is fixed at creation: it is a property of the group that travels in every invite
 * code, and neither the mesh nor Core exposes a way to change it afterwards — doing so would have
 * to reach every member, and there is no gossip message for that. See `docs/APP-MESH.md`.
 */
export function useCreateMeshGroup() {
  const { request } = useMeshApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; coordinator?: string | null }) =>
      request<MeshNodeGroup>("/groups", {
        method: "POST",
        body: JSON.stringify({
          name: input.name.trim(),
          coordinator: input.coordinator?.trim() || null,
        }),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: MESH_QUERY_KEY }),
  });
}

/**
 * Mint an invite code. Administrator only.
 *
 * `POST`, not `GET`: minting is not idempotent — a code snapshots this node's current address and
 * relay so the recipient can dial it.
 */
export function useMintMeshInvite() {
  const { request } = useMeshApi();
  return useMutation({
    mutationFn: (group: string) =>
      request<MeshInvite>(`/groups/${encodeURIComponent(group)}/invite`, {
        method: "POST",
      }),
  });
}

/** Join a group on the *home node* from an invite someone else minted. Administrator only. */
export function useJoinMeshGroupOnNode() {
  const { request } = useMeshApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      request<MeshJoinResponse>("/groups/join", {
        method: "POST",
        body: JSON.stringify({ code: code.trim() }),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: MESH_QUERY_KEY }),
  });
}

/** Leave: the node stops gossiping, drops the index and forgets the secret. Administrator only. */
export function useLeaveMeshGroup() {
  const { request } = useMeshApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (group: string) =>
      request<void>(`/groups/${encodeURIComponent(group)}`, {
        method: "DELETE",
        expectNoContent: true,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: MESH_QUERY_KEY }),
  });
}

// --- the same two calls, outside React Query, for `MeshProvider` -------------------------------

/** The home node's groups. */
export async function fetchMeshGroups(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<MeshNodeGroup[]> {
  const res = await fetch(`${apiBaseUrl}/mesh/groups`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /mesh/groups");
  return (await res.json()) as MeshNodeGroup[];
}

/**
 * An invite for one group, so this device can join it as a light member.
 *
 * Minting an invite to oneself looks odd until you notice that an invite code is the only thing
 * that carries a group's *secret*, and the secret is what gates every peer connection. There is no
 * "export my membership" endpoint because an invite already is one.
 */
export async function fetchMeshInvite(
  apiBaseUrl: string,
  group: string,
  accessToken?: string | null,
): Promise<string> {
  const res = await fetch(
    `${apiBaseUrl}/mesh/groups/${encodeURIComponent(group)}/invite`,
    { method: "POST", headers: authHeaders(accessToken) },
  );
  if (!res.ok) throw await readError(res, `POST /mesh/groups/${group}/invite`);
  const body = (await res.json()) as MeshInvite;
  if (!body?.code) throw new Error("the node returned an invite with no code");
  return body.code;
}
