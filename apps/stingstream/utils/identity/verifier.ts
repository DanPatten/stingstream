import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Turning a password into the value a *different* server stores.
 *
 * Somebody who accepted an invite with a server of their own has an account on both. The one they
 * were invited to must be able to check their password without ever being told it — Dan: *"we need
 * to do this without the OTHER server knowing what that user's password is but it still can
 * validate it"*. So the client does the last step the password ever takes:
 *
 * ```
 * verifier = base64url( PBKDF2-HMAC-SHA256( password, salt, iterations, 32 bytes ) )
 * ```
 *
 * The verifier is what that server is given, and Jellyfin hashes it again with its own KDF before
 * storing it. The salt is made once, when the account is created, and kept by that server so the
 * same password reproduces the same verifier on every later sign-in — which is the whole point:
 * their own server is not involved, so it can be off.
 *
 * ## Why two implementations
 *
 * `crypto.subtle` is present in every browser and does this at native speed, which matters because
 * it sits in front of a sign-in. React Native has no `subtle`, so `@noble/hashes` covers the phone
 * and the television. PBKDF2 is fully specified, so the two agree byte for byte —
 * `verifier.test.ts` pins a vector across both rather than trusting that.
 *
 * ## What the salt is not
 *
 * It is not a secret. It is handed to anybody who asks this server how to sign in as that username,
 * because a client that cannot learn it cannot derive the verifier. Its job is to keep one server's
 * verifier from working on another, and to keep a stolen verifier from being reversed cheaply.
 */

const SALT_BYTES = 16;
const VERIFIER_BYTES = 32;

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/**
 * Bytes to base64url, without `btoa`.
 *
 * The same reason `utils/identity/handoff.ts` avoids it: `btoa` is a browser API and this runs on a
 * phone too. Unpadded, so the value survives being put in a URL fragment and a JSON body.
 */
const toBase64Url = (bytes: Uint8Array): string => {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += alphabet[a >> 2];
    out += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += alphabet[c & 63];
  }
  return out;
};

/** Random bytes, from whatever this platform has. */
const randomBytes = async (count: number): Promise<Uint8Array> => {
  const web = (
    globalThis as {
      crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (web?.getRandomValues) {
    return web.getRandomValues(new Uint8Array(count));
  }
  // Imported here rather than at the top so this module stays free of native modules: it is the
  // one piece of the sign-in that unit tests exercise directly.
  const Crypto = await import("expo-crypto");
  return Crypto.getRandomBytes(count);
};

/** A new salt, for an account that is being linked for the first time. */
export const newSalt = async (): Promise<string> =>
  toBase64Url(await randomBytes(SALT_BYTES));

/**
 * The value to send in place of the password.
 *
 * The salt is used as its own characters rather than decoded first — it only has to be unique and
 * agreed on, and treating it as opaque means no decoder has to match an encoder.
 */
export const deriveVerifier = async (
  password: string,
  salt: string,
  iterations: number,
): Promise<string> => {
  if (!password) throw new Error("A password is required");
  if (!salt) throw new Error("A salt is required");
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("Iterations must be a positive whole number");
  }

  const subtle = (
    globalThis as {
      crypto?: {
        subtle?: {
          importKey: (
            format: string,
            key: Uint8Array,
            algorithm: string,
            extractable: boolean,
            usages: string[],
          ) => Promise<unknown>;
          deriveBits: (
            algorithm: {
              name: string;
              salt: Uint8Array;
              iterations: number;
              hash: string;
            },
            key: unknown,
            length: number,
          ) => Promise<ArrayBuffer>;
        };
      };
    }
  ).crypto?.subtle;

  if (subtle) {
    const key = await subtle.importKey("raw", utf8(password), "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: utf8(salt),
        iterations,
        hash: "SHA-256",
      },
      key,
      VERIFIER_BYTES * 8,
    );
    return toBase64Url(new Uint8Array(bits));
  }

  return toBase64Url(
    await pbkdf2Async(sha256, utf8(password), utf8(salt), {
      c: iterations,
      dkLen: VERIFIER_BYTES,
    }),
  );
};
