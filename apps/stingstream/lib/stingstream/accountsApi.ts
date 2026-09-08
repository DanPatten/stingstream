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

import {
  type CeremonyChallenge,
  createCredential,
  encodeAssertion,
  encodeRegistration,
  getCredential,
} from "./webauthn";

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

export class AccountError extends Error {
  /**
   * True when the service could not be **reached** — as opposed to reached and refused.
   *
   * The distinction is the whole fallback. Unreachable means "sign in here instead, and say why";
   * refused means "that password is wrong centrally, which a local-only user's would be". Treating
   * them the same would either hide an outage or turn every wrong password into one.
   */
  readonly unreachable: boolean;

  constructor(message: string, unreachable = false) {
    super(message);
    this.unreachable = unreachable;
  }
}

/** Whether a failure means "the service is down" rather than "the service said no". */
export const isServiceUnreachable = (error: unknown): boolean =>
  error instanceof AccountError && error.unreachable;

/**
 * Read an error the way both halves report one.
 *
 * The account service and the node both answer `{"error": "..."}` with a sentence written to be
 * read by a person — "that username is taken" — so it is shown as-is rather than replaced by a
 * status code. A body that is not JSON at all means something between here and there answered
 * instead, and that gets a sentence of its own.
 */
const readError = async (
  res: Response,
  what: string,
): Promise<AccountError> => {
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
    // A 5xx is the service having a problem, not an answer about these credentials, so it falls
    // back the same way a dead socket does.
    res.status >= 500,
  );
};

const origin = (service: string) => service.trim().replace(/\/+$/, "");

/**
 * A `fetch` that fails is the service being unreachable, which is the case the whole fallback
 * exists for. Without this the rejection would be a bare `TypeError` and indistinguishable from a
 * refused password.
 */
const reach = async (input: string, init?: RequestInit): Promise<Response> => {
  try {
    return await fetch(input, init);
  } catch (e) {
    throw new AccountError(
      `could not reach the account service (${(e as Error).message})`,
      true,
    );
  }
};

/** Sign in to the account service. */
export async function signIn(
  service: string,
  username: string,
  password: string,
): Promise<AccountSession> {
  const res = await reach(`${origin(service)}/accounts/v1/login`, {
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
  const res = await reach(`${origin(service)}/accounts/v1/me`, {
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
  const res = await reach(`${origin(service)}/accounts/v1/shares`, {
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
  const res = await reach(
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

// --- passkeys ------------------------------------------------------------------------------------
//
// Optional twice over, and both are ordinary rather than exceptional: the service may have been
// built without the feature (`webauthn-rs` needs OpenSSL, which this otherwise-rustls workspace
// does not want on every platform it builds for), and it may have no origin configured, without
// which a passkey would be bound to an address nobody can predict. Either way a password works.

export interface PasskeySupport {
  supported: boolean;
  /** Why not, when not. Written for a person reading a settings screen. */
  reason?: string;
}

/**
 * Can this service do passkeys?
 *
 * The route is answered whether or not the feature was compiled in, which is deliberate on the
 * service's side and relied on here: a **404 would be ambiguous** between "cannot do passkeys" and
 * "older than passkeys", and this client would have to guess. An unreachable service is reported as
 * unsupported rather than thrown, because this is asked to decide whether to draw a button.
 */
export async function fetchPasskeySupport(
  service: string,
): Promise<PasskeySupport> {
  try {
    const res = await fetch(`${origin(service)}/accounts/v1/passkeys`);
    if (!res.ok) return { supported: false };
    return (await res.json()) as PasskeySupport;
  } catch {
    return { supported: false };
  }
}

/**
 * Add a passkey to the account this token belongs to.
 *
 * A token is required because registering a passkey **adds a credential**: it has to be somebody
 * who already proved they hold the account, or a passkey would be a way in rather than a second way
 * in. Returns false when the person dismissed the browser prompt, which is not an error.
 */
export async function registerPasskey(
  service: string,
  token: string,
  label: string,
): Promise<boolean> {
  const begin = await reach(
    `${origin(service)}/accounts/v1/passkeys/register/begin`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!begin.ok) throw await readError(begin, "starting passkey registration");
  const challenge = (await begin.json()) as CeremonyChallenge;

  const credential = await createCredential(challenge.options);
  if (!credential) return false;

  const finish = await reach(
    `${origin(service)}/accounts/v1/passkeys/register/finish`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ceremony: challenge.ceremony,
        reply: encodeRegistration(credential),
        label,
      }),
    },
  );
  if (!finish.ok)
    throw await readError(finish, "finishing passkey registration");
  return true;
}

/**
 * Sign in with a passkey. No token yet — the passkey **is** the credential.
 *
 * A username is still needed to begin, because the service has to know which credentials to offer;
 * a failure at that point answers exactly as a wrong password does, so this cannot be used to find
 * out who has an account. `null` means the prompt was dismissed.
 */
export async function signInWithPasskey(
  service: string,
  username: string,
): Promise<AccountSession | null> {
  const begin = await reach(
    `${origin(service)}/accounts/v1/passkeys/login/begin`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    },
  );
  if (!begin.ok) throw await readError(begin, "signing in");
  const challenge = (await begin.json()) as CeremonyChallenge;

  const credential = await getCredential(challenge.options);
  if (!credential) return null;

  const finish = await reach(
    `${origin(service)}/accounts/v1/passkeys/login/finish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ceremony: challenge.ceremony,
        reply: encodeAssertion(credential),
      }),
    },
  );
  if (!finish.ok) throw await readError(finish, "signing in");
  const body = (await finish.json()) as {
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

/**
 * Whether a server has an account, and where that account lives.
 *
 * Read on the login screen **before anybody types**, because it decides whether a sign-in goes
 * anywhere but here. Accounts are optional: a node that has never been claimed answers with no
 * service, and its sign-in never leaves the machine.
 *
 * Anonymous on purpose. This is asked by somebody who is not signed in yet — that is the whole
 * point — so it is the one account route the node answers without a session, and it says nothing a
 * stranger could not learn by looking at the login screen: whether there is an account, and which
 * public service it is on. The username is deliberately **not** here.
 */
export interface LoginNodeAccount {
  claimed: boolean;
  service: string | null;
}

export async function fetchLoginNodeAccount(
  serverOrigin: string,
): Promise<LoginNodeAccount> {
  try {
    const res = await fetch(
      `${origin(serverOrigin)}/stingstream/api/v1/accounts/public`,
    );
    if (!res.ok) return { claimed: false, service: null };
    const body = (await res.json()) as {
      Claimed?: boolean;
      claimed?: boolean;
      Service?: string | null;
      service?: string | null;
    };
    return {
      claimed: body.Claimed ?? body.claimed ?? false,
      service: body.Service ?? body.service ?? null,
    };
  } catch {
    // A node too old to know the route, or one that did not answer. Either way there is no account
    // to sign in through, and the local form is the right thing to show.
    return { claimed: false, service: null };
  }
}
