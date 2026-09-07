import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import {
  type Age,
  authHeaders,
  type GroupCounts,
  type GroupSyncState,
  type LinkPath,
  type MemberRow,
  type MeshGroupMembers,
  type MeshInvite,
  type MeshJoinResponse,
  type MeshMember,
  type MeshNodeGroup,
  type MeshNodePeer,
  type MeshNodeStatus,
  type MeshRotation,
  MeshUnavailableError,
  readError,
  toGroup,
  toInviteCode,
  toJoin,
  toMembers,
  toPeer,
  toRotation,
  toStatus,
} from "./meshApi";

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
 *
 * This file is the React Query layer only. The types and the plain-fetch functions live in
 * `./meshApi` — re-exported below so nothing that already imports from here needs to change — and
 * are kept there specifically so a non-React caller (`castStreamUrl.ts`, and its unit tests) never
 * has to load `providers/JellyfinProvider`'s import graph just to make a `fetch` call.
 */

export {
  ageOf,
  canManageMembers,
  canRemoveMember,
  confirmedAction,
  fetchMeshGroups,
  fetchMeshInvite,
  fetchMeshPeers,
  fetchMeshStatus,
  groupCounts,
  groupSyncState,
  initials,
  latestPeerActivity,
  memberDisplayName,
  memberRoster,
  pathCategory,
  rttLabel,
  shortenNodeId,
} from "./meshApi";
/** Re-exported so a screen can take the record without reaching past this module. */
export type { SideDoorRecord } from "./sidedoor";
export type {
  Age,
  GroupCounts,
  GroupSyncState,
  LinkPath,
  MemberRow,
  MeshGroupMembers,
  MeshInvite,
  MeshJoinResponse,
  MeshMember,
  MeshNodeGroup,
  MeshNodePeer,
  MeshNodeStatus,
  MeshRotation,
};
export { MeshUnavailableError };

const useMeshApi = () => {
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const base = api?.basePath ? getStingStreamApiBaseUrl(api.basePath) : null;
  const token = api?.accessToken ?? null;

  return {
    base,
    /**
     * A connected server *and* a session on it.
     *
     * Every route under `/mesh` needs Jellyfin's elevated policy, so asking before the user has
     * signed in can only produce a 401 — and since v0.2.0's auto-connect the server is set the
     * moment a node-served page loads, which put a pair of red 401s in the console of the login
     * screen itself. The queries below wait for the session.
     */
    authed: !!base && !!user?.Id,
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
  const { base, authed, request } = useMeshApi();
  return useQuery({
    queryKey: [...MESH_QUERY_KEY, "groups", base],
    queryFn: async () => (await request<unknown[]>("/groups")).map(toGroup),
    enabled: authed,
    // Membership changes rarely; the peer list below is what needs to be fresh.
    refetchInterval: 30_000,
    // A 503 (the mesh child is down) is not transient in the way a dropped packet is — retrying
    // the app default's three times just delays the "mesh isn't running" state the screen already
    // has for exactly this.
    retry: 1,
  });
}

/** Members of one group as the *home node* sees them, with liveness and path. */
export function useNodeMeshPeers(
  group: string | null | undefined,
): UseQueryResult<MeshNodePeer[]> {
  const { base, authed, request } = useMeshApi();
  return useQuery({
    queryKey: [...MESH_QUERY_KEY, "peers", base, group ?? "all"],
    queryFn: async () =>
      (
        await request<unknown[]>(
          group ? `/peers?group=${encodeURIComponent(group)}` : "/peers",
        )
      ).map(toPeer),
    enabled: authed,
    refetchInterval: 10_000,
    retry: 1,
  });
}

export function useNodeMeshStatus(): UseQueryResult<MeshNodeStatus> {
  const { base, authed, request } = useMeshApi();
  return useQuery({
    queryKey: [...MESH_QUERY_KEY, "status", base],
    queryFn: async () => toStatus(await request<unknown>("/status")),
    enabled: authed,
    refetchInterval: 15_000,
    retry: 1,
  });
}

/**
 * Create a group on the home node. Administrator only.
 *
 * The coordinator chosen here is a property of the group and travels in every invite code. It is no
 * longer permanent: `useSetGroupCoordinator` below changes it afterwards and every member follows,
 * which M4.5 added along with the gossip record that makes it reach them. See `docs/MESH.md`,
 * "Changing a group's coordinator".
 */
export function useCreateMeshGroup() {
  const { request } = useMeshApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; coordinator?: string | null }) =>
      toGroup(
        await request<unknown>("/groups", {
          method: "POST",
          body: JSON.stringify({
            name: input.name.trim(),
            coordinator: input.coordinator?.trim() || null,
          }),
        }),
      ),
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
    mutationFn: async (group: string): Promise<MeshInvite> => ({
      code: toInviteCode(
        await request<unknown>(`/groups/${encodeURIComponent(group)}/invite`, {
          method: "POST",
        }),
      ),
    }),
  });
}

/** Join a group on the *home node* from an invite someone else minted. Administrator only. */
export function useJoinMeshGroupOnNode() {
  const { request } = useMeshApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) =>
      toJoin(
        await request<unknown>("/groups/join", {
          method: "POST",
          body: JSON.stringify({ code: code.trim() }),
        }),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: MESH_QUERY_KEY }),
  });
}

/**
 * Point a group at a different coordinator. Administrator only.
 *
 * `coordinator: null` is a real value — it puts the group back on public infrastructure — so this
 * takes an explicit null rather than an optional field. The home node does the whole change: it
 * stamps it, re-seeds its own relay map, announces at the new coordinator's rendezvous and gossips
 * a signed record every other member applies under a last-writer-wins rule. Nothing here has to
 * poll for that; the other members' own screens follow within a gossip round.
 *
 * Invite codes minted afterwards carry the new value automatically, so a code copied *before* the
 * change is not invalidated — it still joins, and the joiner adopts the real coordinator from the
 * group's own gossip. See `docs/MESH.md`, "Changing a group's coordinator".
 */
export function useSetGroupCoordinator() {
  const { request } = useMeshApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      group,
      coordinator,
    }: {
      group: string;
      coordinator: string | null;
    }) =>
      request<unknown>(`/groups/${encodeURIComponent(group)}/coordinator`, {
        method: "PUT",
        body: JSON.stringify({ coordinator }),
      }).then(toGroup),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: MESH_QUERY_KEY }),
  });
}

/**
 * Every member of one group, removed ones included. Administrator only.
 *
 * Elevated where `useNodeMeshPeers` is not, because the two answer different questions: peers is
 * liveness and paths, which anybody watching a film has a reason to see, and this is the roster —
 * node ids, last-seen times and who has been removed — which is the screen the Remove action lives
 * on. So pass `null` for `group` whenever the account cannot manage the group and the query never
 * runs at all, rather than firing a request that comes back 403.
 */
export function useNodeMeshMembers(
  group: string | null | undefined,
): UseQueryResult<MeshGroupMembers> {
  const { base, authed, request } = useMeshApi();
  return useQuery({
    queryKey: [...MESH_QUERY_KEY, "members", base, group ?? "none"],
    queryFn: async () =>
      toMembers(
        await request<unknown>(
          `/groups/${encodeURIComponent(group as string)}/members`,
        ),
      ),
    enabled: authed && !!group,
    // Slower than the peer list: a roster changes when somebody is invited or removed, not when a
    // laptop goes to sleep.
    refetchInterval: 30_000,
    retry: 1,
  });
}

/**
 * Remove a member and rotate the group's secret. Administrator only.
 *
 * **This can take minutes.** The node mints the new secret and then hands it to every other member
 * in turn, each dial bounded but serial, and only answers once it can say who actually took it —
 * so a group with several sleeping members is a long wait rather than a hung request. Nothing here
 * imposes a timeout of its own: Core already caps it at three minutes, and giving up earlier would
 * abandon a rotation that has already happened on the node.
 *
 * It is also irreversible. The removed node is refused from this moment, every remaining member
 * gets a new secret, and **every invite code minted before now stops working** — including one this
 * screen showed a minute ago. Re-inviting is the only way back, which is why the screen asks first.
 */
export function useRemoveMeshMember() {
  const { request } = useMeshApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ group, node }: { group: string; node: string }) =>
      request<unknown>(
        `/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(node)}`,
        { method: "DELETE" },
      ).then(toRotation),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: MESH_QUERY_KEY }),
  });
}

/**
 * Rotate a group's secret without removing anybody. Administrator only.
 *
 * For when a code leaked rather than when a person left. Same cost and same wait as a removal —
 * the whole group has to be handed the new secret either way — and the same consequence for invite
 * codes already in circulation.
 *
 * The light node inside this app is an ordinary member of the group, so it is rekeyed by the mesh
 * along with everybody else. That is why this does not call `MeshProvider.syncGroups()` the way
 * leaving does: the device's *membership* has not changed, only the secret behind it, and that
 * travels over the mesh rather than through the app.
 */
export function useRotateGroupSecret() {
  const { request } = useMeshApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (group: string) =>
      request<unknown>(`/groups/${encodeURIComponent(group)}/rotate`, {
        method: "POST",
      }).then(toRotation),
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
