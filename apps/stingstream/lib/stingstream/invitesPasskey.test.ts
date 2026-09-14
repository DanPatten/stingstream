import { beforeAll, describe, expect, test } from "bun:test";
import i18n from "i18next";
import en from "../../translations/en.json";
import { acceptInviteWithPasskey, InviteRequestError } from "./invitesApi";

const ORIGIN = "http://localhost:8790";

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init({
      lng: "en",
      fallbackLng: "en",
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false },
    });
  }
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const CHALLENGE = {
  Ceremony: "c-1",
  Options: { publicKey: { challenge: "AAAA" } },
};

function stubFetch(responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

const fakeCredential = {} as PublicKeyCredential;

describe("acceptInviteWithPasskey", () => {
  test("the token and name go in the body, never the URL", async () => {
    const { impl, calls } = stubFetch([
      json(200, CHALLENGE),
      json(200, { AccessToken: "t", User: { Id: "u", Name: "sam" } }),
    ]);

    await acceptInviteWithPasskey(
      ORIGIN,
      { token: "secret-token", username: "sam" },
      {
        fetch: impl,
        createCredential: async () => fakeCredential,
        encodeRegistration: () => ({ id: "cred" }),
      },
    );

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).not.toContain("secret-token");
    }
    const finish = JSON.parse(String(calls[1].init?.body));
    expect(finish).toMatchObject({
      Token: "secret-token",
      Username: "sam",
      Ceremony: "c-1",
      Credential: { id: "cred" },
    });
  });

  test("returns the whole user from the session", async () => {
    const { impl } = stubFetch([
      json(200, CHALLENGE),
      json(200, {
        AccessToken: "t",
        User: { Id: "u", Name: "sam", Policy: { IsAdministrator: false } },
      }),
    ]);

    const session = await acceptInviteWithPasskey(
      ORIGIN,
      { token: "x", username: "sam" },
      {
        fetch: impl,
        createCredential: async () => fakeCredential,
        encodeRegistration: () => ({}),
      },
    );

    expect(session?.user?.Policy?.IsAdministrator).toBe(false);
  });

  /** A dismissed prompt must never create the account: the invite stays unspent. */
  test("a dismissed prompt returns null and never calls finish", async () => {
    const { impl, calls } = stubFetch([json(200, CHALLENGE)]);

    const session = await acceptInviteWithPasskey(
      ORIGIN,
      { token: "x", username: "sam" },
      { fetch: impl, createCredential: async () => null },
    );

    expect(session).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("a spent invite is reported as spent, in the node's words", async () => {
    const { impl } = stubFetch([
      json(410, { Error: "This invite has already been used." }),
    ]);

    const error = await acceptInviteWithPasskey(
      ORIGIN,
      { token: "x", username: "sam" },
      { fetch: impl, createCredential: async () => fakeCredential },
    ).catch((e) => e);

    expect(error).toBeInstanceOf(InviteRequestError);
    expect((error as InviteRequestError).kind).toBe("spent");
    expect((error as InviteRequestError).message).toBe(
      "This invite has already been used.",
    );
  });

  test("a taken name is reported before any prompt", async () => {
    let prompted = false;
    const { impl } = stubFetch([
      json(400, {
        Error: "That name is already taken on this server. Choose another.",
      }),
    ]);

    const error = await acceptInviteWithPasskey(
      ORIGIN,
      { token: "x", username: "dan" },
      {
        fetch: impl,
        createCredential: async () => {
          prompted = true;
          return fakeCredential;
        },
      },
    ).catch((e) => e);

    expect((error as InviteRequestError).kind).toBe("invalid");
    expect(prompted).toBe(false);
  });
});
