import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { MESH_QUERY_KEY } from "./mesh";
import {
  authHeaders,
  both,
  field,
  type MeshJoinResponse,
  readError,
  toJoin,
} from "./meshApi";

/**
 * Connecting this server to another: `StingStream.Core`'s `ConnectionsController`.
 *
 * An administrator makes an invite, choosing what this server shares as part of making it. An
 * administrator on the other server uses it, choosing what theirs shares as part of using it. A
 * member who brings an invite files a request, which an administrator approves in one step. See
 * `utils/mesh/connectionLink.ts` for the links themselves.
 */

/** What an invite link is built from. */
export interface ConnectionInvite {
  code: string;
  node: string;
  server: string;
}

/** An invite link waiting for an administrator here. Never carries the code. */
export interface ConnectionRequestSummary {
  id: string;
  node: string;
  serverName: string;
  requestedByName: string;
  createdAt: string;
  mine: boolean;
}

/** The API base for a node, from the origin its `/stingstream/api/v1` hangs off. */
export const connectionsBase = (apiBaseUrl: string): string =>
  `${apiBaseUrl.replace(/\/+$/, "")}/connections`;

/** Core writes a sentence for every refusal on this controller. Prefer it to a status line. */
const failure = async (res: Response, what: string): Promise<Error> => {
  if (res.status === 401 || res.status === 403 || res.status === 503) {
    return readError(res, what);
  }
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error.trim()) {
      return new Error(body.error);
    }
  } catch {
    // Not JSON.
  }
  return readError(res, what);
};

const send = async (
  url: string,
  method: string,
  token: string | null | undefined,
  body?: unknown,
): Promise<Response> =>
  fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...authHeaders(token),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/**
 * Make an invite that shares `libraries`. Administrator only.
 *
 * `null` shares every library, which is what a picker nobody touched means.
 */
export async function createConnectionInvite(
  apiBaseUrl: string,
  token: string | null | undefined,
  libraries: string[] | null,
): Promise<ConnectionInvite> {
  const res = await send(
    `${connectionsBase(apiBaseUrl)}/invite`,
    "POST",
    token,
    libraries === null ? {} : { libraries },
  );
  if (!res.ok) throw await failure(res, "POST /connections/invite");
  const raw = (await res.json()) as unknown;
  return {
    code: field<string>(raw, ...both("code")) ?? "",
    node: field<string>(raw, ...both("node")) ?? "",
    server: field<string>(raw, ...both("server")) ?? "",
  };
}

/** Use another server's invite, sharing `libraries` back. Administrator only. */
export async function connectToServer(
  apiBaseUrl: string,
  token: string | null | undefined,
  code: string,
  libraries: string[] | null,
): Promise<MeshJoinResponse> {
  const res = await send(
    `${connectionsBase(apiBaseUrl)}/connect`,
    "POST",
    token,
    libraries === null ? { code } : { code, libraries },
  );
  if (!res.ok) throw await failure(res, "POST /connections/connect");
  return toJoin(await res.json());
}

/** Bring an invite here for an administrator to approve. Any member. */
export async function saveConnectionRequest(
  apiBaseUrl: string,
  token: string | null | undefined,
  input: { code: string; node: string; serverName: string },
): Promise<void> {
  const res = await send(
    `${connectionsBase(apiBaseUrl)}/requests`,
    "POST",
    token,
    input,
  );
  if (!res.ok) throw await failure(res, "POST /connections/requests");
}

const toRequest = (raw: unknown): ConnectionRequestSummary => ({
  id: field<string>(raw, ...both("id")) ?? "",
  node: field<string>(raw, ...both("node")) ?? "",
  serverName: field<string>(raw, ...both("serverName")) ?? "",
  requestedByName: field<string>(raw, ...both("requestedByName")) ?? "",
  createdAt: field<string>(raw, ...both("createdAt")) ?? "",
  mine: field<boolean>(raw, ...both("mine")) ?? false,
});

const useConnectionsApi = () => {
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  return {
    base: api?.basePath ? getStingStreamApiBaseUrl(api.basePath) : null,
    token: api?.accessToken ?? null,
    authed: Boolean(api?.basePath) && Boolean(user?.Id),
  };
};

export const CONNECTIONS_QUERY_KEY = ["stingstream", "connections"] as const;

/** Kept out of the persisted cache: a request is answered by somebody else, on another screen. */
const LIVE = { persist: false } as const;

/** Requests waiting here: all of them for an administrator, a member's own for a member. */
export function useConnectionRequests(): UseQueryResult<
  ConnectionRequestSummary[]
> {
  const { base, token, authed } = useConnectionsApi();
  return useQuery({
    queryKey: [...CONNECTIONS_QUERY_KEY, "requests", base],
    meta: LIVE,
    queryFn: async () => {
      const res = await send(
        `${connectionsBase(base!)}/requests`,
        "GET",
        token,
      );
      if (!res.ok) throw await failure(res, "GET /connections/requests");
      const body = (await res.json()) as unknown;
      return Array.isArray(body) ? body.map(toRequest) : [];
    },
    enabled: authed,
    refetchInterval: 30_000,
    retry: 1,
  });
}

/** Everything a connection changes: the mesh's own view, and the requests list. */
const useInvalidate = () => {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: MESH_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
  };
};

export function useCreateConnectionInvite() {
  const { base, token } = useConnectionsApi();
  const invalidate = useInvalidate();
  return useMutation<ConnectionInvite, Error, string[] | null>({
    mutationFn: (libraries) => createConnectionInvite(base!, token, libraries),
    onSuccess: invalidate,
  });
}

export function useConnectToServer() {
  const { base, token } = useConnectionsApi();
  const invalidate = useInvalidate();
  return useMutation<
    MeshJoinResponse,
    Error,
    { code: string; libraries: string[] | null }
  >({
    mutationFn: ({ code, libraries }) =>
      connectToServer(base!, token, code, libraries),
    onSuccess: invalidate,
  });
}

export function useSaveConnectionRequest() {
  const { base, token } = useConnectionsApi();
  const invalidate = useInvalidate();
  return useMutation<
    void,
    Error,
    { code: string; node: string; serverName: string }
  >({
    mutationFn: (input) => saveConnectionRequest(base!, token, input),
    onSuccess: invalidate,
  });
}

export function useApproveConnectionRequest() {
  const { base, token } = useConnectionsApi();
  const invalidate = useInvalidate();
  return useMutation<
    MeshJoinResponse,
    Error,
    { id: string; libraries: string[] | null }
  >({
    mutationFn: async ({ id, libraries }) => {
      const res = await send(
        `${connectionsBase(base!)}/requests/${encodeURIComponent(id)}/approve`,
        "POST",
        token,
        libraries === null ? {} : { libraries },
      );
      if (!res.ok) throw await failure(res, "POST /connections/requests/approve");
      return toJoin(await res.json());
    },
    // Settled rather than success: an approval of a spent invite removes the request too.
    onSettled: invalidate,
  });
}

/** Decline a request, or withdraw your own. */
export function useDeclineConnectionRequest() {
  const { base, token } = useConnectionsApi();
  const invalidate = useInvalidate();
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      const res = await send(
        `${connectionsBase(base!)}/requests/${encodeURIComponent(id)}`,
        "DELETE",
        token,
      );
      if (!res.ok && res.status !== 404) {
        throw await failure(res, "DELETE /connections/requests");
      }
    },
    onSuccess: invalidate,
  });
}
