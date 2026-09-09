import { authHeaders, readError } from "./meshApi";

/**
 * Signing in to a server with an account you hold on another one.
 *
 * Three halves with three different callers, which is why they are one file:
 *
 * * **anonymous, on the server being signed in to** — `requestChallenge` and `signInWithAssertion`.
 *   Called by somebody with no session there, which is the entire point. Plain `fetch` against the
 *   node's origin rather than the generated client, for the reason `invitesApi.ts` and `setup.ts`
 *   both give: that client is keyed on an authenticated `apiAtom` there is no session for yet.
 * * **authenticated, on your own server** — `vouchForMe`. This is the half your *own* node runs
 *   when you are the one signing in elsewhere.
 * * **administrator** — `fetchLinks` and `removeLink`, the list of who from elsewhere holds an
 *   account here.
 *
 * **The assertion is never put in a URL.** It signs its holder in, so it is a credential: it rides
 * in the return link's fragment, which a browser does not send, and every call here puts it in a
 * request body. Same rule, for the same reason, as the invite token.
 */

const CHALLENGE_PATH = "/stingstream/api/v1/identity/challenge";
const VOUCH_PATH = "/stingstream/api/v1/identity/vouch";
const SIGNIN_PATH = "/stingstream/api/v1/identity/signin";

/** How long one call gets before it is called unreachable. */
const REQUEST_TIMEOUT_MS = 10_000;

/** What the far server wants signed. */
export interface IdentityChallenge {
  nonce: string;
  /** That server's node id — what the assertion is bound to. */
  audience: string;
  serverName: string;
  expiresAt: string | null;
}

/** A statement your own server signed about you. */
export interface SignedAssertion {
  assertion: string;
  nodeId: string;
  serverName: string;
}

/**
 * What Core hands back once you are signed in — a session.
 *
 * The user comes back whole rather than as an id and a name, because the caller hands it straight
 * to `adoptSession`, which is what Quick Connect and passkey sign-ins already use: all three end
 * with a token and a user and nothing left to verify.
 */
export interface IdentitySession {
  accessToken: string | null;
  user: Record<string, unknown> | null;
  username: string;
}

/** One remote identity holding an account here. */
export interface LinkedIdentity {
  id: string;
  remoteUserName: string;
  issuerName: string;
  issuerNodeId: string;
  localUserName: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export type IdentityErrorKind =
  /** The server said no, with a sentence worth showing. */
  | "refused"
  /** Nothing answered, or it took too long. */
  | "unreachable"
  /** It answered, and not with anything we can use. */
  | "server";

export class IdentityRequestError extends Error {
  readonly kind: IdentityErrorKind;

  constructor(kind: IdentityErrorKind, message: string) {
    super(message);
    this.name = "IdentityRequestError";
    this.kind = kind;
  }
}

/** Injectable for tests; the app always uses the global. */
export type FetchLike = typeof fetch;

export interface IdentityRequestOptions {
  fetch?: FetchLike;
}

async function request(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<Response> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: abort.signal });
  } catch (e) {
    throw new IdentityRequestError(
      "unreachable",
      (e as Error)?.message ?? "That server did not answer.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Core writes a sentence for every refusal; prefer it over a generic one. */
async function refusalSentence(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { Error?: unknown };
    return typeof body?.Error === "string" && body.Error.trim().length > 0
      ? body.Error
      : null;
  } catch {
    return null;
  }
}

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify(body),
});

const origin = (nodeOrigin: string) => nodeOrigin.replace(/\/+$/, "");

/**
 * Ask a server for a nonce to have your own server sign.
 *
 * Anonymous, and what it reveals — this node's id and name — is what
 * `/sidedoor/v1/hello` already tells any caller. What it does not reveal is anything about who
 * holds an account there.
 */
export async function requestChallenge(
  nodeOrigin: string,
  options: IdentityRequestOptions = {},
): Promise<IdentityChallenge> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await request(
    `${origin(nodeOrigin)}${CHALLENGE_PATH}`,
    jsonPost({}),
    fetchImpl,
  );

  if (!response.ok) {
    throw new IdentityRequestError(
      response.status === 503 ? "unreachable" : "server",
      (await refusalSentence(response)) ??
        "That server cannot start a sign-in right now.",
    );
  }

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const audience = typeof body?.Audience === "string" ? body.Audience : "";
  const nonce = typeof body?.Nonce === "string" ? body.Nonce : "";
  if (!audience || !nonce) {
    // Without both, an assertion would be unbound or replayable. Refuse here rather than build a
    // link that cannot work.
    throw new IdentityRequestError(
      "server",
      "That server's answer was incomplete.",
    );
  }

  return {
    nonce,
    audience,
    serverName: typeof body?.ServerName === "string" ? body.ServerName : "",
    expiresAt: typeof body?.ExpiresAt === "string" ? body.ExpiresAt : null,
  };
}

/**
 * Have *your own* server sign a statement about you, for another one.
 *
 * Needs a session on your own server, and nothing more: what it produces is a statement about
 * yourself that is only usable at the one audience named in it.
 */
export async function vouchForMe(
  nodeOrigin: string,
  input: { audience: string; nonce: string },
  accessToken?: string | null,
  options: IdentityRequestOptions = {},
): Promise<SignedAssertion> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await request(
    `${origin(nodeOrigin)}${VOUCH_PATH}`,
    {
      ...jsonPost({ Audience: input.audience, Nonce: input.nonce }),
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...authHeaders(accessToken),
      },
    },
    fetchImpl,
  );

  if (!response.ok) {
    throw new IdentityRequestError(
      "refused",
      (await refusalSentence(response)) ??
        "Your server could not sign you in to the other one.",
    );
  }

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const assertion = typeof body?.Assertion === "string" ? body.Assertion : "";
  if (!assertion) {
    throw new IdentityRequestError(
      "server",
      "Your server's answer was incomplete.",
    );
  }

  return {
    assertion,
    nodeId: typeof body?.NodeId === "string" ? body.NodeId : "",
    serverName: typeof body?.ServerName === "string" ? body.ServerName : "",
  };
}

/**
 * Present an assertion and get a session back.
 *
 * `inviteToken` is needed the first time and ignored afterwards: a genuine assertion from a server
 * nobody there has heard of proves who you are and grants nothing, or every StingStream server
 * would accept every other one's users.
 */
export async function signInWithAssertion(
  nodeOrigin: string,
  input: {
    assertion: string;
    inviteToken?: string | null;
    requestLink?: boolean;
  },
  options: IdentityRequestOptions = {},
): Promise<IdentitySession> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await request(
    `${origin(nodeOrigin)}${SIGNIN_PATH}`,
    jsonPost({
      Assertion: input.assertion,
      InviteToken: input.inviteToken ?? null,
      RequestLink: input.requestLink === true,
    }),
    fetchImpl,
  );

  if (!response.ok) {
    throw new IdentityRequestError(
      "refused",
      (await refusalSentence(response)) ?? "That sign-in could not be used.",
    );
  }

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const user = (body?.User ?? null) as Record<string, unknown> | null;
  const accessToken =
    typeof body?.AccessToken === "string" ? body.AccessToken : null;

  if (!accessToken || !user) {
    // A 200 with no session is not a success with a gap in it; it is a response we cannot act on,
    // and treating it as a sign-in would leave somebody looking at a signed-out app that believes
    // it is signed in.
    throw new IdentityRequestError(
      "server",
      "That server did not return a session.",
    );
  }

  return {
    accessToken,
    user,
    username: typeof user.Name === "string" ? user.Name : "",
  };
}

/** Who from elsewhere holds an account here. Administrator only. */
export async function fetchLinks(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<LinkedIdentity[]> {
  const res = await fetch(`${apiBaseUrl}/identity/links`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /identity/links");
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? body.map(toLink) : [];
}

/** Stop one of them signing in. The account stays. */
export async function removeLink(
  apiBaseUrl: string,
  issuerNodeId: string,
  remoteUserId: string,
  accessToken?: string | null,
): Promise<void> {
  const res = await fetch(
    `${apiBaseUrl}/identity/links/${encodeURIComponent(issuerNodeId)}/${encodeURIComponent(remoteUserId)}`,
    { method: "DELETE", headers: authHeaders(accessToken) },
  );
  if (!res.ok && res.status !== 404) {
    throw await readError(res, "DELETE /identity/links");
  }
}

const toLink = (raw: unknown): LinkedIdentity => {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof r.Id === "string" ? r.Id : "",
    remoteUserName:
      typeof r.RemoteUserName === "string" ? r.RemoteUserName : "",
    issuerName: typeof r.IssuerName === "string" ? r.IssuerName : "",
    issuerNodeId: typeof r.IssuerNodeId === "string" ? r.IssuerNodeId : "",
    localUserName: typeof r.LocalUserName === "string" ? r.LocalUserName : "",
    createdAt: typeof r.CreatedAt === "string" ? r.CreatedAt : "",
    lastSeenAt: typeof r.LastSeenAt === "string" ? r.LastSeenAt : null,
  };
};

// --- link requests ------------------------------------------------------------------------------

/** One server asking to be linked with this one, as the administrator's list shows it. */
export interface LinkRequestSummary {
  issuerNodeId: string;
  issuerName: string;
  requestedByName: string;
  createdAt: string;
  status: "pending" | "approved" | "declined";
  groupId: string | null;
}

/** What the person who asked is told about their own request. */
export interface MyLinkRequest {
  exists: boolean;
  status: "" | "pending" | "approved" | "declined";
  issuerNodeId: string;
  serverName: string;
  /** The invite to redeem on your own server, once it has been approved. */
  code: string | null;
}

const readStatus = (raw: unknown): LinkRequestSummary["status"] =>
  raw === "approved" || raw === "declined" ? raw : "pending";

/** Ask for the server you run to be linked with this one. */
export async function requestLink(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/identity/link-requests`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  if (!res.ok) {
    throw new IdentityRequestError(
      "refused",
      (await refusalSentence(res)) ?? "That request could not be made.",
    );
  }
}

/** What your own request is doing, and the invite once it is approved. */
export async function fetchMyLinkRequest(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<MyLinkRequest> {
  const res = await fetch(`${apiBaseUrl}/identity/link-requests/mine`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /identity/link-requests/mine");
  const body = (await res.json()) as Record<string, unknown>;
  return {
    exists: body?.Exists === true,
    status:
      typeof body?.Status === "string"
        ? (body.Status as MyLinkRequest["status"])
        : "",
    issuerNodeId:
      typeof body?.IssuerNodeId === "string" ? body.IssuerNodeId : "",
    serverName: typeof body?.ServerName === "string" ? body.ServerName : "",
    code: typeof body?.Code === "string" ? body.Code : null,
  };
}

/** Which servers have asked. Administrator only. */
export async function fetchLinkRequests(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<LinkRequestSummary[]> {
  const res = await fetch(`${apiBaseUrl}/identity/link-requests`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /identity/link-requests");
  const body = (await res.json()) as unknown;
  return Array.isArray(body)
    ? body.map((raw) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        return {
          issuerNodeId:
            typeof r.IssuerNodeId === "string" ? r.IssuerNodeId : "",
          issuerName: typeof r.IssuerName === "string" ? r.IssuerName : "",
          requestedByName:
            typeof r.RequestedByName === "string" ? r.RequestedByName : "",
          createdAt: typeof r.CreatedAt === "string" ? r.CreatedAt : "",
          status: readStatus(r.Status),
          groupId: typeof r.GroupId === "string" ? r.GroupId : null,
        };
      })
    : [];
}

/** Let one in, into a group of your choosing. */
export async function approveLinkRequest(
  apiBaseUrl: string,
  issuerNodeId: string,
  groupId: string | null,
  accessToken?: string | null,
): Promise<void> {
  const res = await fetch(
    `${apiBaseUrl}/identity/link-requests/${encodeURIComponent(issuerNodeId)}/approve`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(accessToken),
      },
      body: JSON.stringify({ GroupId: groupId }),
    },
  );
  if (!res.ok) {
    // A 400 here is an administrator's own choice still to make -- which link to add them to --
    // and Core writes the sentence for it.
    throw new IdentityRequestError(
      "refused",
      (await refusalSentence(res)) ?? "That could not be approved.",
    );
  }
}

/** Say no to one. */
export async function declineLinkRequest(
  apiBaseUrl: string,
  issuerNodeId: string,
  accessToken?: string | null,
): Promise<void> {
  const res = await fetch(
    `${apiBaseUrl}/identity/link-requests/${encodeURIComponent(issuerNodeId)}/decline`,
    { method: "POST", headers: authHeaders(accessToken) },
  );
  if (!res.ok && res.status !== 404) {
    throw await readError(res, "POST /identity/link-requests/decline");
  }
}
