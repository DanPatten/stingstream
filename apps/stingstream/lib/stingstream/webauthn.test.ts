import { describe, expect, test } from "bun:test";
import {
  decodeOptions,
  encodeAssertion,
  encodeRegistration,
  fromBase64Url,
  type JsonCredentialOptions,
  passkeysAvailableHere,
  toBase64Url,
} from "./webauthn";

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

describe("base64url", () => {
  test("round-trips the bytes that break a naive implementation", () => {
    // 0xFB 0xFF and 0xFF 0xEF are exactly the byte pairs standard base64 spells with `+` and `/`.
    // A conversion that forgets the `-_` substitution passes every test written with ASCII and
    // then fails on perhaps one credential in twenty, long after the change that caused it.
    const awkward = bytes(0xfb, 0xff, 0xbf, 0xff, 0xef, 0x00, 0x01, 0x02);
    const encoded = toBase64Url(awkward);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect(new Uint8Array(fromBase64Url(encoded))).toEqual(
      new Uint8Array(awkward),
    );
  });

  test("decodes a string whose length needs padding restored", () => {
    // WebAuthn ids are unpadded, and their lengths are whatever the authenticator chose. All three
    // remainders have to work, not just the one a fixture happened to have.
    for (const length of [1, 2, 3, 4, 5]) {
      const source = bytes(...Array.from({ length }, (_, i) => i + 1));
      expect(new Uint8Array(fromBase64Url(toBase64Url(source)))).toEqual(
        new Uint8Array(source),
      );
    }
  });
});

describe("decodeOptions", () => {
  const options: JsonCredentialOptions = {
    publicKey: {
      challenge: toBase64Url(bytes(1, 2, 3)),
      user: {
        id: toBase64Url(bytes(9, 9)),
        name: "alice",
        displayName: "alice",
      },
      allowCredentials: [{ id: toBase64Url(bytes(7)), type: "public-key" }],
      rp: { id: "example.org", name: "StingStream" },
      timeout: 60000,
      userVerification: "preferred",
    },
  };

  test("converts every binary field and nothing else", () => {
    const decoded = decodeOptions(options) as unknown as Record<
      string,
      unknown
    >;

    expect(new Uint8Array(decoded.challenge as ArrayBuffer)).toEqual(
      new Uint8Array(bytes(1, 2, 3)),
    );
    const user = decoded.user as { id: ArrayBuffer; name: string };
    expect(new Uint8Array(user.id)).toEqual(new Uint8Array(bytes(9, 9)));
    expect(user.name).toBe("alice");
    const allow = decoded.allowCredentials as { id: ArrayBuffer }[];
    expect(new Uint8Array(allow[0].id)).toEqual(new Uint8Array(bytes(7)));

    // Everything else is passed through untouched, so a field the service starts sending tomorrow
    // arrives without a change here.
    expect(decoded.rp).toEqual({ id: "example.org", name: "StingStream" });
    expect(decoded.timeout).toBe(60000);
    expect(decoded.userVerification).toBe("preferred");
  });

  test("leaves out the lists the ceremony did not send", () => {
    const decoded = decodeOptions({
      publicKey: { challenge: toBase64Url(bytes(1)) },
    }) as unknown as Record<string, unknown>;
    expect(decoded.user).toBeUndefined();
    expect(decoded.allowCredentials).toBeUndefined();
    expect(decoded.excludeCredentials).toBeUndefined();
  });
});

describe("encoding a reply", () => {
  test("a registration matches what the service deserialises", () => {
    const credential = {
      id: "credential-id",
      rawId: bytes(1, 2),
      type: "public-key",
      response: {
        attestationObject: bytes(3, 4),
        clientDataJSON: bytes(5, 6),
      },
    } as unknown as PublicKeyCredential;

    expect(encodeRegistration(credential)).toEqual({
      id: "credential-id",
      rawId: toBase64Url(bytes(1, 2)),
      type: "public-key",
      response: {
        attestationObject: toBase64Url(bytes(3, 4)),
        clientDataJSON: toBase64Url(bytes(5, 6)),
        // Present even when the browser has no `getTransports`, because the server refuses a body
        // without it -- `[Required]` on Fido2NetLib's own model, checked by ASP.NET before any of
        // this reaches the ceremony. An absent field is a 400 nobody could debug from the browser.
        transports: [],
      },
      extensions: {},
      clientExtensionResults: {},
    });
  });

  test("a registration carries the transports the browser does report", () => {
    const credential = {
      id: "credential-id",
      rawId: bytes(1, 2),
      type: "public-key",
      response: {
        attestationObject: bytes(3, 4),
        clientDataJSON: bytes(5, 6),
        getTransports: () => ["internal", "hybrid"],
      },
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
    } as unknown as PublicKeyCredential;

    const encoded = encodeRegistration(credential);
    expect(encoded.response.transports).toEqual(["internal", "hybrid"]);
    expect(encoded.clientExtensionResults).toEqual({ credProps: { rk: true } });
  });

  test("a browser that throws from getClientExtensionResults still produces a valid body", () => {
    // It is a method call into the browser's own credential object, and the one thing that must
    // not happen is a registration failing on the reporting of extensions nobody asked for.
    const credential = {
      id: "credential-id",
      rawId: bytes(1),
      type: "public-key",
      response: { attestationObject: bytes(2), clientDataJSON: bytes(3) },
      getClientExtensionResults: () => {
        throw new Error("no");
      },
    } as unknown as PublicKeyCredential;

    expect(encodeRegistration(credential).clientExtensionResults).toEqual({});
  });

  test("an assertion sends null for a missing user handle", () => {
    // Optional in the spec, and the service tells "not given" apart from "empty" -- so an absent
    // handle has to be null rather than an empty string, which would decode to zero bytes.
    const credential = {
      id: "credential-id",
      rawId: bytes(1),
      type: "public-key",
      response: {
        authenticatorData: bytes(2),
        clientDataJSON: bytes(3),
        signature: bytes(4),
        userHandle: null,
      },
    } as unknown as PublicKeyCredential;

    expect(encodeAssertion(credential).response.userHandle).toBeNull();
    // Required by the server on this ceremony too, for the same reason.
    expect(encodeAssertion(credential).clientExtensionResults).toEqual({});
  });
});

describe("passkeysAvailableHere", () => {
  test("is false where there is no WebAuthn, which is every native build", () => {
    // bun has no `PublicKeyCredential`, which is the same answer a phone gives. The point of the
    // check is that a button is never drawn for a method that cannot work.
    expect(passkeysAvailableHere()).toBe(false);
  });
});
