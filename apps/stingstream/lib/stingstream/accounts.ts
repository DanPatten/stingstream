/**
 * This node's account, as the app reads and changes it.
 *
 * Everything here goes to **your own server**, under `/stingstream/api/v1/accounts` — not to the
 * account service. Creating an account, attaching a second machine and resetting a password are all
 * things only a server can vouch for, so they are all requests it signs on your behalf.
 *
 * Signing *in* is the other direction and lives in `accountsApi.ts`, which talks to the service.
 */

import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { authHeaders, readError } from "./meshApi";

export interface NodeAccount {
  service: string | null;
  account: string | null;
  username: string | null;
  node: string;
}

export const ACCOUNT_QUERY_KEY = ["stingstream", "account"] as const;

const useAccountApi = () => {
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const base = api?.basePath ? getStingStreamApiBaseUrl(api.basePath) : null;
  const token = api?.accessToken ?? null;

  return {
    base,
    // Everything here is elevated, so asking before there is a session can only produce a 401 —
    // the same reasoning as the mesh hooks.
    authed: !!base && !!user?.Id,
    request: async <T>(path: string, init?: RequestInit): Promise<T> => {
      if (!base) throw new Error("no node is connected");
      const res = await fetch(`${base}/accounts${path}`, {
        ...init,
        headers: {
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...authHeaders(token),
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok)
        throw await readError(res, `${init?.method ?? "GET"} accounts${path}`);
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    },
  };
};

const toAccount = (raw: unknown): NodeAccount => {
  const read = (name: string) => {
    const record = (raw ?? {}) as Record<string, unknown>;
    const value =
      record[name] ?? record[name.charAt(0).toUpperCase() + name.slice(1)];
    return typeof value === "string" && value.trim() ? value : null;
  };
  return {
    service: read("service"),
    account: read("account"),
    username: read("username"),
    node: read("node") ?? "",
  };
};

/** Which account service this server uses, and whose account it belongs to. */
export function useNodeAccount() {
  const { base, authed, request } = useAccountApi();
  return useQuery({
    queryKey: [...ACCOUNT_QUERY_KEY, base],
    queryFn: async () => toAccount(await request<unknown>("")),
    enabled: authed,
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * Create an account, or attach this server to one that exists.
 *
 * One mutation for both, because they are one form: the same username and password, and `claim`
 * decides which. The password is required for a claim too — a signature alone would let somebody
 * attach a machine they control to an account that is not theirs, and an attached machine can reset
 * that account's password.
 */
export function useRegisterNodeAccount() {
  const { base, request } = useAccountApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      username: string;
      password: string;
      claim: boolean;
    }) =>
      toAccount(
        await request<unknown>("/register", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
    onSuccess: (status) =>
      queryClient.setQueryData([...ACCOUNT_QUERY_KEY, base], status),
  });
}

/**
 * Set a new password on the account this server belongs to.
 *
 * The only recovery there is: no email means no reset link, so owning a machine the account owns is
 * the proof.
 */
export function useResetNodeAccount() {
  const { request } = useAccountApi();
  return useMutation({
    mutationFn: async (password: string) =>
      toAccount(
        await request<unknown>("/reset", {
          method: "POST",
          body: JSON.stringify({ password }),
        }),
      ),
  });
}
