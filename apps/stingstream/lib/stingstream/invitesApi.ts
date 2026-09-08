import { t } from "i18next";
import { authHeaders, readError } from "./meshApi";

/**
 * Person invites: the link an administrator sends, and what happens when somebody opens it.
 *
 * Two halves with different callers, in one file because they are one feature.
 *
 * The **anonymous** half — `lookupInvite` and `acceptInvite` — is called by somebody who has no
 * account anywhere, which is the entire point of an invite. Like `lib/stingstream/setup.ts` it goes
 * through plain `fetch` against the node's origin rather than the generated client, because that
 * client is keyed on an authenticated `apiAtom` there is no session for yet.
 *
 * The **administrator** half — minting, listing, revoking — follows `meshApi.ts`: hand-written
 * fetch with the Jellyfin token, so it can be unit-tested without dragging `react-native` in.
 *
 * **The token is never put in a URL.** It rides in the link's fragment, which a browser does not
 * send, and every call here puts it in a request body. A `GET /invites/{token}` would have written
 * the credential into the node's access log, the gateway's, and every proxy in between — where it
 * would outlive the invite by however long logs are kept.
 */

const LOOKUP_PATH = "/stingstream/api/v1/invites/lookup";
const ACCEPT_PATH = "/stingstream/api/v1/invites/accept";

/** How long one call gets before it is called unreachable. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Core's own rules, mirrored so a typo is caught before a round trip. */
export const INVITE_LABEL_MAX_LENGTH = 64;
export const INVITE_MAX_EXPIRY_DAYS = 365;
export const INVITE_DEFAULT_EXPIRY_DAYS = 7;

/** A library an invite grants, or could. */
export interface InviteLibrary {
  id: string;
  name: string;
  /** `movies`, `tvshows` and so on, or absent when it has no type. */
  collectionType?: string | null;
}

/** What somebody who opened a link is shown, before they have an account. */
export interface InviteDescription {
  serverName: string;
  invitedBy: string;
  libraries: InviteLibrary[];
  expiresAt: string;
}

/** One invite in the administrator's list. */
export interface InviteSummary {
  id: string;
  label: string;
  libraries: InviteLibrary[];
  createdByName: string;
  createdAt: string;
  expiresAt: string;
  status: "valid" | "expired" | "used" | "revoked";
  redeemedUserName?: string | null;
  redeemedAt?: string | null;
}

/** A freshly minted invite. The only time the token is ever returned. */
export interface MintedInvite {
  token: string;
  /** The link to send, or null when this server has no address anybody could open. */
  url: string | null;
  invite: InviteSummary;
}

/**
 * Why an invite call was refused, in terms a screen can act on rather than an HTTP status.
 *
 * - `unknown` — no invite has ever had this token. Almost always a mangled link: a chat client
 *   that ate the fragment, or half a URL pasted.
 * - `spent` — there was one, and it cannot be used. `message` says which of used, expired or
 *   withdrawn, in the node's own words.
 * - `invalid` — the name or the password is not usable; `message` says which.
 * - `unreachable` — nothing answered.
 * - `server` — it answered with something nobody planned for.
 */
export type InviteErrorKind =
  | "unknown"
  | "spent"
  | "invalid"
  | "unreachable"
  | "server";

/** A refused invite call. `message` is already fit to show. */
export class InviteRequestError extends Error {
  readonly kind: InviteErrorKind;

  constructor(kind: InviteErrorKind, message: string) {
    super(message);
    this.name = "InviteRequestError";
    this.kind = kind;
  }
}

/** Injectable for tests; the app always uses the global. */
export type FetchLike = typeof fetch;

export interface InviteRequestOptions {
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
  } catch {
    throw new InviteRequestError("unreachable", t("invites.error_unreachable"));
  } finally {
    clearTimeout(timeout);
  }
}

/** The `{Error}` sentence Core sends with a refusal, when it sent one. */
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
  headers: {
    "content-type": "application/json",
    accept: "application/json",
  },
  body: JSON.stringify(body),
});

/**
 * Core answers PascalCase — it is serialised by Jellyfin's own serializer, which every route
 * hosted inside Jellyfin shares — while the app speaks camelCase everywhere else. Converting at
 * the boundary is what stops `Libraries` leaking into a component.
 */
const toLibrary = (raw: unknown): InviteLibrary => {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof r.Id === "string" ? r.Id : "",
    name: typeof r.Name === "string" ? r.Name : "",
    collectionType:
      typeof r.CollectionType === "string" ? r.CollectionType : null,
  };
};

const toLibraries = (raw: unknown): InviteLibrary[] =>
  Array.isArray(raw) ? raw.map(toLibrary) : [];

const toSummary = (raw: unknown): InviteSummary => {
  const r = (raw ?? {}) as Record<string, unknown>;
  const status = typeof r.Status === "string" ? r.Status : "expired";
  return {
    id: typeof r.Id === "string" ? r.Id : "",
    label: typeof r.Label === "string" ? r.Label : "",
    libraries: toLibraries(r.Libraries),
    createdByName: typeof r.CreatedByName === "string" ? r.CreatedByName : "",
    createdAt: typeof r.CreatedAt === "string" ? r.CreatedAt : "",
    expiresAt: typeof r.ExpiresAt === "string" ? r.ExpiresAt : "",
    // An unrecognised status is treated as expired rather than valid: a node newer than this
    // bundle could name a state we have never heard of, and the safe reading of "I don't know
    // what this invite is" is that it cannot be used.
    status:
      status === "valid" || status === "used" || status === "revoked"
        ? status
        : "expired",
    redeemedUserName:
      typeof r.RedeemedUserName === "string" ? r.RedeemedUserName : null,
    redeemedAt: typeof r.RedeemedAt === "string" ? r.RedeemedAt : null,
  };
};

// --- the anonymous half: somebody who opened a link -----------------------------------------

/**
 * What this invite is: whose server, who sent it, and what it lets you watch.
 *
 * A `404` and a `410` mean different things and the landing page shows different screens for them.
 * A token that never existed is nearly always a mangled link — a chat client that stripped the
 * fragment, or half a URL — and the useful thing to say is "check the link". A token that *was* an
 * invite gets the node's own sentence, which says whether it was used, expired or withdrawn, and
 * ends in "ask whoever sent it for a new one".
 */
export async function lookupInvite(
  origin: string,
  token: string,
  options: InviteRequestOptions = {},
): Promise<InviteDescription> {
  const { fetch: fetchImpl = fetch } = options;
  const response = await request(
    `${origin}${LOOKUP_PATH}`,
    jsonPost({ Token: token }),
    fetchImpl,
  );

  if (response.status === 404) {
    throw new InviteRequestError("unknown", t("invites.error_unknown"));
  }
  if (response.status === 410) {
    throw new InviteRequestError(
      "spent",
      (await refusalSentence(response)) ?? t("invites.error_spent"),
    );
  }
  if (!response.ok) {
    throw new InviteRequestError("server", t("invites.error_unexpected"));
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new InviteRequestError("server", t("invites.error_unexpected"));
  }

  return {
    serverName: typeof body.ServerName === "string" ? body.ServerName : "",
    invitedBy: typeof body.InvitedBy === "string" ? body.InvitedBy : "",
    libraries: toLibraries(body.Libraries),
    expiresAt: typeof body.ExpiresAt === "string" ? body.ExpiresAt : "",
  };
}

/** What Core hands back once the account exists — a session for it. */
export interface AcceptedInvite {
  accessToken: string | null;
  userId: string | null;
  username: string;
}

/**
 * Create the account this invite is for.
 *
 * The answer is a sign-in, so the caller can go straight to the library rather than showing a login
 * form to somebody who has just chosen a password. A body that cannot be read is **not** treated as
 * a failure: the account exists by then, and the caller signs in with the credentials it already
 * has — the same reasoning `setup.ts` gives for the same case.
 */
export async function acceptInvite(
  origin: string,
  credentials: { token: string; username: string; password: string },
  options: InviteRequestOptions = {},
): Promise<AcceptedInvite> {
  const { fetch: fetchImpl = fetch } = options;
  const response = await request(
    `${origin}${ACCEPT_PATH}`,
    jsonPost({
      Token: credentials.token,
      Username: credentials.username,
      Password: credentials.password,
    }),
    fetchImpl,
  );

  if (response.status === 400) {
    throw new InviteRequestError(
      "invalid",
      (await refusalSentence(response)) ?? t("invites.error_invalid"),
    );
  }
  if (response.status === 404) {
    throw new InviteRequestError("unknown", t("invites.error_unknown"));
  }
  if (response.status === 410) {
    throw new InviteRequestError(
      "spent",
      (await refusalSentence(response)) ?? t("invites.error_spent"),
    );
  }
  if (!response.ok) {
    throw new InviteRequestError("server", t("invites.error_unexpected"));
  }

  let body: {
    AccessToken?: unknown;
    User?: { Id?: unknown; Name?: unknown } | null;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { accessToken: null, userId: null, username: credentials.username };
  }

  return {
    accessToken:
      typeof body?.AccessToken === "string" ? body.AccessToken : null,
    userId: typeof body?.User?.Id === "string" ? body.User.Id : null,
    username:
      typeof body?.User?.Name === "string"
        ? body.User.Name
        : credentials.username,
  };
}

// --- the administrator's half ----------------------------------------------------------------

/** Every library on this server, for the picker. */
export async function fetchInviteLibraries(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<InviteLibrary[]> {
  const res = await fetch(`${apiBaseUrl}/invites/libraries`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /invites/libraries");
  return toLibraries(await res.json());
}

/** Every invite this server has minted, newest first. */
export async function fetchInvites(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<InviteSummary[]> {
  const res = await fetch(`${apiBaseUrl}/invites`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /invites");
  const body = await res.json();
  return Array.isArray(body) ? body.map(toSummary) : [];
}

/** Mint one. The token in the answer is the only copy that will ever exist. */
export async function mintInvite(
  apiBaseUrl: string,
  input: { label?: string; libraries: string[]; expiresInDays?: number },
  accessToken?: string | null,
): Promise<MintedInvite> {
  const res = await fetch(`${apiBaseUrl}/invites`, {
    method: "POST",
    headers: {
      ...authHeaders(accessToken),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      Label: input.label ?? "",
      Libraries: input.libraries,
      ExpiresInDays: input.expiresInDays ?? INVITE_DEFAULT_EXPIRY_DAYS,
    }),
  });
  if (!res.ok) {
    // A 400 here is the administrator's own mistake -- no library picked, or one that has since
    // been removed -- and Core writes a sentence for it. Preferred over `readError`'s generic
    // shape, which would bury it behind "POST /invites: 400".
    if (res.status === 400) {
      const sentence = await refusalSentence(res);
      if (sentence) throw new InviteRequestError("invalid", sentence);
    }
    throw await readError(res, "POST /invites");
  }
  const body = (await res.json()) as Record<string, unknown>;
  return {
    token: typeof body.Token === "string" ? body.Token : "",
    url: typeof body.Url === "string" && body.Url.length > 0 ? body.Url : null,
    invite: toSummary(body.Invite),
  };
}

/** Withdraw one. Addressed by id, never by token. */
export async function revokeInvite(
  apiBaseUrl: string,
  id: string,
  accessToken?: string | null,
): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/invites/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  // 404 means it was already withdrawn or already gone, which is the state the caller was asking
  // for. Reporting it as a failure would put an error in front of somebody who got what they
  // wanted, usually from double-tapping.
  if (!res.ok && res.status !== 404) {
    throw await readError(res, "DELETE /invites");
  }
}
