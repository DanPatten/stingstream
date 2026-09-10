import { describe, expect, test } from "bun:test";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { deriveVerifier, newSalt } from "./verifier";

// The value a linked account signs in with. Two things are pinned here and neither is optional:
// that the WebCrypto path and the pure-JS path agree byte for byte — a client on a phone and the
// same person's browser must produce the same verifier or one of them cannot sign in — and that the
// derivation actually depends on every input it claims to.

// Small on purpose. The rounds are a cost, not a property, and every assertion below holds at any
// count.
const ROUNDS = 1000;

describe("deriveVerifier", () => {
  test("is the same value every time", async () => {
    const a = await deriveVerifier("correct horse", "s4lt", ROUNDS);
    const b = await deriveVerifier("correct horse", "s4lt", ROUNDS);
    expect(a).toBe(b);
  });

  test("matches the pure-JS implementation the phone uses", async () => {
    // WebCrypto answers in this runtime, so this is the cross-check: the same inputs through
    // @noble/hashes, encoded the same way. If either side ever drifts, this fails rather than
    // locking somebody out of one of their devices.
    const viaSubtle = await deriveVerifier("correct horse", "s4lt", ROUNDS);
    const raw = await pbkdf2Async(
      sha256,
      new TextEncoder().encode("correct horse"),
      new TextEncoder().encode("s4lt"),
      { c: ROUNDS, dkLen: 32 },
    );
    expect(Buffer.from(viaSubtle, "base64url")).toEqual(Buffer.from(raw));
  });

  test("a different password, salt or count is a different verifier", async () => {
    const base = await deriveVerifier("correct horse", "s4lt", ROUNDS);
    expect(await deriveVerifier("correct horsf", "s4lt", ROUNDS)).not.toBe(
      base,
    );
    expect(await deriveVerifier("correct horse", "s4lu", ROUNDS)).not.toBe(
      base,
    );
    expect(await deriveVerifier("correct horse", "s4lt", ROUNDS + 1)).not.toBe(
      base,
    );
  });

  test("is url-safe and unpadded, because it rides in a fragment", async () => {
    const value = await deriveVerifier("correct horse", "s4lt", ROUNDS);
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("refuses inputs that would silently weaken it", async () => {
    await expect(deriveVerifier("", "s4lt", ROUNDS)).rejects.toThrow();
    await expect(deriveVerifier("pw", "", ROUNDS)).rejects.toThrow();
    await expect(deriveVerifier("pw", "s4lt", 0)).rejects.toThrow();
    await expect(deriveVerifier("pw", "s4lt", 1.5)).rejects.toThrow();
  });
});

describe("newSalt", () => {
  test("is url-safe and does not repeat", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const salt = await newSalt();
      expect(salt).toMatch(/^[A-Za-z0-9_-]+$/);
      seen.add(salt);
    }
    expect(seen.size).toBe(20);
  });
});
