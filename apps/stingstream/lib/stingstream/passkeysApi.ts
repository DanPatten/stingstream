import { t } from "i18next";
import { authHeaders, readError } from "./meshApi";
import {
  type CeremonyChallenge,
  createCredential,
  encodeAssertion,
  encodeRegistration,
  getCredential,
  type JsonCredentialOptions,
} from "./webauthn";

/**
 * Passkeys, on the server in front of you.
 *
 * They used to live on a central account service; they live on the node now, bound to that node's
 * own domain. Which is a better arrangement than the one it replaces rather than a fallback: the
 * deleted version bound every passkey to one shared hostname, so all of them would have stopped
 * working the day that service moved. Bound to your own domain there is nothing to move.
 *
 * `webauthn.ts` does the binary translation and the browser prompt; this file is the network half.
 * The split is what lets the encoding be tested without a browser, which is the only place
 * `navigator.credentials` exists at all.
 *
 * **Nothing here is required.** A password always works, `support()` says whether to draw a button
 * at all, and a cancelled prompt is `null` rather than an error — somebody changing their mind is
 * not a failure worth a red message.
 */

const PASSKEYS_PATH = "/stingstream/api/v1/passkeys";

/** Whether this server can offer passkeys. */
export interface PasskeySupport {
  supported: boolean;
  /** One sentence saying why not, or null. */
  reason: string | null;
  /** The domain they bind to, or null. */
  relyingParty: string | null;
}

/** One registered passkey, as its owner sees it. */
export interface PasskeySummary {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** False when it was made for an address this server no longer answers to. */
  usable: boolean;
  relyingParty: string;
}

/** A refused passkey call, already fit to show. */
export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyError";
  }
}

const readSentence = async (res: Response): Promise<string | null> => {
  try {
    const body = (await res.json()) as { Error?: unknown };
    return typeof body?.Error === "string" && body.Error.trim().length > 0
      ? body.Error
      : null;
  } catch {
    return null;
  }
};

const toChallenge = (body: unknown): CeremonyChallenge => {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    ceremony: typeof b.Ceremony === "string" ? b.Ceremony : "",
    // `Options` is passed straight through: the server sends the WebAuthn options verbatim inside
    // a `{publicKey: …}` envelope, and `decodeOptions` forwards every field it does not recognise.
    // A field the spec gains tomorrow needs no change at either end.
    options: b.Options as JsonCredentialOptions,
  };
};

/**
 * Whether this server can offer passkeys.
 *
 * Anonymous, because the sign-in screen has to decide whether to draw the button before anybody has
 * signed in. Any failure answers "no" rather than throwing: a server that cannot be asked is a
 * server whose password form is the right thing to show.
 */
export async function fetchPasskeySupport(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PasskeySupport> {
  try {
    const res = await fetchImpl(`${origin}${PASSKEYS_PATH}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { supported: false, reason: null, relyingParty: null };
    const body = (await res.json()) as Record<string, unknown>;
    return {
      supported: body.Supported === true,
      reason: typeof body.Reason === "string" ? body.Reason : null,
      relyingParty:
        typeof body.RelyingParty === "string" ? body.RelyingParty : null,
    };
  } catch {
    // An older node has no such route, and a node that is still starting answers nothing. Both
    // mean "no passkeys here", which is a complete answer rather than an error to report.
    return { supported: false, reason: null, relyingParty: null };
  }
}

/**
 * Sign in with a passkey.
 *
 * Takes no username, because the credentials are discoverable: the authenticator already knows
 * which ones it holds for this domain and offers them itself. That is both the nicer flow — press
 * the button, you are in — and the one that does not let an anonymous caller ask whether an account
 * exists here.
 *
 * Resolves to `null` when the person dismissed the prompt.
 */
export async function signInWithPasskey(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  accessToken: string | null;
  userId: string | null;
  username: string;
} | null> {
  const begun = await fetchImpl(`${origin}${PASSKEYS_PATH}/login/begin`, {
    method: "POST",
    headers: { accept: "application/json" },
  });
  if (!begun.ok) {
    throw new PasskeyError(
      (await readSentence(begun)) ?? t("passkeys.error_unavailable"),
    );
  }

  const challenge = toChallenge(await begun.json());
  const credential = await getCredential(challenge.options);
  if (!credential) return null;

  const finished = await fetchImpl(`${origin}${PASSKEYS_PATH}/login/finish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      Ceremony: challenge.ceremony,
      Credential: encodeAssertion(credential),
    }),
  });
  if (!finished.ok) {
    throw new PasskeyError(
      (await readSentence(finished)) ?? t("passkeys.error_sign_in"),
    );
  }

  const body = (await finished.json()) as {
    AccessToken?: unknown;
    User?: { Id?: unknown; Name?: unknown } | null;
  };
  return {
    accessToken:
      typeof body?.AccessToken === "string" ? body.AccessToken : null,
    userId: typeof body?.User?.Id === "string" ? body.User.Id : null,
    username: typeof body?.User?.Name === "string" ? body.User.Name : "",
  };
}

/**
 * Add a passkey to the account already signed in here.
 *
 * Resolves to `false` when the person dismissed the prompt, which is not an error.
 */
export async function registerPasskey(
  apiBaseUrl: string,
  label: string,
  accessToken?: string | null,
): Promise<boolean> {
  const begun = await fetch(`${apiBaseUrl}/passkeys/register/begin`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  if (!begun.ok) {
    throw new PasskeyError(
      (await readSentence(begun)) ?? t("passkeys.error_unavailable"),
    );
  }

  const challenge = toChallenge(await begun.json());
  const credential = await createCredential(challenge.options);
  if (!credential) return false;

  const finished = await fetch(`${apiBaseUrl}/passkeys/register/finish`, {
    method: "POST",
    headers: {
      ...authHeaders(accessToken),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      Ceremony: challenge.ceremony,
      Credential: encodeRegistration(credential),
      Label: label,
    }),
  });
  if (!finished.ok) {
    throw new PasskeyError(
      (await readSentence(finished)) ?? t("passkeys.error_register"),
    );
  }
  return true;
}

/** The passkeys on the signed-in account. */
export async function fetchPasskeys(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<PasskeySummary[]> {
  const res = await fetch(`${apiBaseUrl}/passkeys/credentials`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /passkeys/credentials");
  const body = await res.json();
  return Array.isArray(body)
    ? body.map((raw) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        return {
          id: typeof r.Id === "string" ? r.Id : "",
          label: typeof r.Label === "string" ? r.Label : "",
          createdAt: typeof r.CreatedAt === "string" ? r.CreatedAt : "",
          lastUsedAt: typeof r.LastUsedAt === "string" ? r.LastUsedAt : null,
          usable: r.Usable === true,
          relyingParty:
            typeof r.RelyingParty === "string" ? r.RelyingParty : "",
        };
      })
    : [];
}

/** Remove one. The server scopes the delete to the caller, so this cannot touch anybody else's. */
export async function deletePasskey(
  apiBaseUrl: string,
  id: string,
  accessToken?: string | null,
): Promise<void> {
  const res = await fetch(
    `${apiBaseUrl}/passkeys/credentials/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: authHeaders(accessToken) },
  );
  // 404 means it is already gone, which is the state the caller asked for.
  if (!res.ok && res.status !== 404) {
    throw await readError(res, "DELETE /passkeys/credentials");
  }
}
