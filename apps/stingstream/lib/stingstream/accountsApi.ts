/**
 * StingStream accounts, as the app talks to them.
 *
 * Two different servers answer the calls here, and which one matters:
 *
 * - **The account service** answers `/accounts/v1/login` and `/accounts/v1/me`. It knows who you
 *   are and which servers you can reach, and nothing else — no media, no metadata, no watch
 *   history.
 * - **Your own node** answers everything under `/stingstream/api/v1/accounts`. Registering, resetting
 *   and exchanging a token for a session all happen there, because all three are things only a
 *   server can vouch for.
 *
 * Plain `fetch` and no React, like `meshApi.ts` and for the same reason: `bun:test` can load this,
 * where anything reaching `providers/JellyfinProvider` cannot.
 */

/** The account service every install points at unless told otherwise. */
export const DEFAULT_ACCOUNT_SERVICE =
  "https://stingstream-accounts-production.up.railway.app";

/** A server this account can reach, as `GET /accounts/v1/me` lists it. */
export interface AccountServer {
  /** The node id, which is how the account service knows it. */
  node: string;
  name: string;
  /** Where a client can reach it, when the owner has set an address. */
  address: string;
  /** True when this account owns the server, false when it is only shared with by it. */
  owned: boolean;
  /** Which libraries are shared. Empty means all of them; absent on a server you own. */
  libraries?: string[];
}

export interface AccountMe {
  account: string;
  username: string;
  servers: AccountServer[];
}

export interface AccountSession {
  token: string;
  /** Seconds. The client re-signs in rather than refreshing; there is nothing to refresh. */
  expiresIn: number;
  account: string;
  username: string;
}

/** What this node knows about accounts: which service, and whose account it is. */
export interface NodeAccountStatus {
  service: string | null;
  account: string | null;
  username: string | null;
  node: string;
}

export class AccountError extends Error {}

/**
 * Read an error the way both halves report one.
 *
 * The account service and the node both answer `{"error": "..."}` with a sentence written to be
 * read by a person — "that username is taken" — so it is shown as-is rather than replaced by a
 * status code. A body that is not JSON at all means something between here and there answered
 * instead, and that gets a sentence of its own.
 */
const readError = async (res: Response, what: string): Promise<AccountError> => {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed?.error) return new AccountError(parsed.error);
  } catch {
    // Fall through: not JSON.
  }
  return new AccountError(
    text.trim().length > 0 && text.length < 200
      ? text.trim()
      : `${what} failed (${res.status})`,
  );
};

const origin = (service: string) => service.trim().replace(/\/+$/, "");

/** Sign in to the account service. */
export async function signIn(
  service: string,
  username: string,
  password: string,
): Promise<AccountSession> {
  const res = await fetch(`${origin(service)}/accounts/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw await readError(res, "signing in");
  const body = (await res.json()) as {
    token: string;
    expires_in: number;
    account: string;
    username: string;
  };
  return {
    token: body.token,
    expiresIn: body.expires_in,
    account: body.account,
    username: body.username,
  };
}

/** Everything this account has: its own servers, and the ones sharing with it. */
export async function fetchMe(
  service: string,
  token: string,
): Promise<AccountMe> {
  const res = await fetch(`${origin(service)}/accounts/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await readError(res, "reading your account");
  return (await res.json()) as AccountMe;
}

/** Share libraries on a server you own, or stop. */
export async function setShare(
  service: string,
  token: string,
  input: { node: string; username: string; libraries?: string[] },
  action: "share" | "revoke",
): Promise<void> {
  const res = await fetch(`${origin(service)}/accounts/v1/shares`, {
    method: action === "share" ? "PUT" : "DELETE",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      node: input.node,
      username: input.username,
      libraries: input.libraries ?? [],
    }),
  });
  if (!res.ok) throw await readError(res, "changing what is shared");
}

/**
 * Turn an account token into a session on one server.
 *
 * The server checks the token itself, against a key it cached when it was claimed — so this works
 * with the account service switched off, which is the entire reason the design is signature-based.
 */
export async function sessionOn(
  serverOrigin: string,
  token: string,
): Promise<unknown> {
  const res = await fetch(
    `${origin(serverOrigin)}/stingstream/api/v1/accounts/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    },
  );
  if (!res.ok) throw await readError(res, "signing in to that server");
  return await res.json();
}

/**
 * Where a server can actually be reached, given what the account service knows about it.
 *
 * The address is whatever its owner set under Sharing, and it is often empty — most people have no
 * domain. `null` is therefore an ordinary answer meaning "this server exists but this client cannot
 * open it from here", which the UI shows rather than hides: a shared library you cannot reach is
 * worth explaining, and pretending it is offline would send somebody looking at the wrong thing.
 */
export const serverOrigin = (server: AccountServer): string | null => {
  const address = server.address?.trim();
  if (!address) return null;
  return address.replace(/\/+$/, "");
};
