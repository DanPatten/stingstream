/**
 * Passkeys, on the one platform that has them.
 *
 * The WebAuthn API speaks `ArrayBuffer`; JSON does not. So the account service sends and receives
 * every binary field as **base64url without padding** — that is what `webauthn-rs` emits, and what
 * `Base64UrlSafeData` accepts back — and this file is the translation in both directions. The
 * conversions are pure and live apart from the network calls so they can be tested without a
 * browser, which is the only place `navigator.credentials` exists at all.
 *
 * Nothing here is required. A password always works, and every entry point below answers "no"
 * rather than throwing when passkeys are unavailable — which is the ordinary case on native, on a
 * service built without the feature, and on a service that has no origin configured.
 */

/** The WebAuthn options a browser wants, with the binary fields still base64url strings. */
export interface JsonCredentialOptions {
  publicKey: {
    challenge: string;
    user?: { id: string; name: string; displayName: string };
    excludeCredentials?: { id: string; type: string; transports?: string[] }[];
    allowCredentials?: { id: string; type: string; transports?: string[] }[];
    [key: string]: unknown;
  };
}

/** One ceremony, as the service hands it over: an id to carry, and the options to answer. */
export interface CeremonyChallenge {
  ceremony: string;
  options: JsonCredentialOptions;
}

/**
 * base64url, no padding — the encoding every binary field in WebAuthn JSON uses.
 *
 * Written out rather than reached for from a library because there is exactly one of each and both
 * are four lines, and because getting the `+/` → `-_` substitution wrong fails in a way that only
 * shows up on the credentials whose bytes happen to contain those characters: perhaps one sign-in
 * in twenty, long after the change that caused it.
 */
export const toBase64Url = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 1)
    binary += String.fromCharCode(view[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export const fromBase64Url = (value: string): ArrayBuffer => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

/**
 * Turn the service's JSON into the object `navigator.credentials` will accept.
 *
 * Only the fields that are actually binary are converted; everything else — the relying party, the
 * timeout, the user-verification preference — is passed through untouched, so a field the service
 * starts sending tomorrow arrives without a change here.
 */
export const decodeOptions = (
  options: JsonCredentialOptions,
): PublicKeyCredentialCreationOptions & PublicKeyCredentialRequestOptions => {
  const source = options.publicKey;
  const decoded: Record<string, unknown> = { ...source };
  decoded.challenge = fromBase64Url(source.challenge);
  if (source.user) {
    decoded.user = { ...source.user, id: fromBase64Url(source.user.id) };
  }
  for (const key of ["excludeCredentials", "allowCredentials"] as const) {
    const list = source[key];
    if (Array.isArray(list)) {
      decoded[key] = list.map((c) => ({ ...c, id: fromBase64Url(c.id) }));
    }
  }
  // Through `unknown`, because the two option types disagree about which fields are required and
  // this one object legitimately satisfies whichever the caller is running. Narrowing it to one of
  // them would mean two near-identical decoders whose only difference is a type assertion.
  return decoded as unknown as PublicKeyCredentialCreationOptions &
    PublicKeyCredentialRequestOptions;
};

/** A registration reply, in the shape `RegisterPublicKeyCredential` deserialises from. */
export const encodeRegistration = (credential: PublicKeyCredential) => {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      attestationObject: toBase64Url(response.attestationObject),
      clientDataJSON: toBase64Url(response.clientDataJSON),
    },
    extensions: {},
  };
};

/** A sign-in reply, in the shape `PublicKeyCredential` deserialises from. */
export const encodeAssertion = (credential: PublicKeyCredential) => {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: toBase64Url(response.authenticatorData),
      clientDataJSON: toBase64Url(response.clientDataJSON),
      signature: toBase64Url(response.signature),
      // Null rather than absent when the authenticator did not supply one: the field is optional in
      // the spec and the service distinguishes "not given" from "empty".
      userHandle: response.userHandle ? toBase64Url(response.userHandle) : null,
    },
    extensions: {},
  };
};

/**
 * Can this device do passkeys at all?
 *
 * Separate from whether the *service* can, and both have to be true. This one is false on native
 * and on any browser without WebAuthn, and it is checked before a button is drawn rather than after
 * it is pressed — offering a sign-in method that cannot work is worse than not offering it.
 */
export const passkeysAvailableHere = (): boolean =>
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { PublicKeyCredential?: unknown })
    .PublicKeyCredential !== "undefined" &&
  typeof globalThis.navigator?.credentials?.create === "function";

/**
 * Run the browser half of a ceremony.
 *
 * A user cancelling the prompt throws `NotAllowedError`, which is not a failure worth an alarming
 * message — it is somebody changing their mind — so it is turned into `null` and the caller simply
 * does nothing. Everything else is a real error and is rethrown.
 */
const ceremony = async (
  kind: "create" | "get",
  options: JsonCredentialOptions,
): Promise<PublicKeyCredential | null> => {
  const publicKey = decodeOptions(options);
  try {
    const credential =
      kind === "create"
        ? await navigator.credentials.create({ publicKey })
        : await navigator.credentials.get({ publicKey });
    return (credential as PublicKeyCredential) ?? null;
  } catch (e) {
    if ((e as Error)?.name === "NotAllowedError") return null;
    throw e;
  }
};

export const createCredential = (options: JsonCredentialOptions) =>
  ceremony("create", options);

export const getCredential = (options: JsonCredentialOptions) =>
  ceremony("get", options);
