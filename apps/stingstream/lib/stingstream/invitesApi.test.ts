import { beforeAll, describe, expect, test } from "bun:test";
import i18n from "i18next";
import en from "../../translations/en.json";
import { acceptInvite, InviteRequestError, lookupInvite } from "./invitesApi";

const ORIGIN = "http://localhost:8790";

/**
 * The real catalogue, on the real i18next instance `invitesApi.ts` imports `t` from — without it
 * every message is the empty string and the assertions pass vacuously, and with it this spec fails
 * if one of the keys it names is removed from `en.json`.
 */
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

/** A `fetch` that answers once, and records what it was asked. */
function stubFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return responder(String(input), init);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const bodyOf = (init?: RequestInit) =>
  JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

describe("lookupInvite", () => {
  /**
   * The property this whole design rests on. The token is a credential that creates an account;
   * putting it in a path or a query string writes it into the node's access log, the gateway's,
   * and every proxy in between, where it outlives the invite by however long logs are kept.
   */
  test("the token goes in the body, never in the URL", async () => {
    const { impl, calls } = stubFetch(() =>
      json(200, {
        ServerName: "Dan's Attic",
        InvitedBy: "dan",
        Libraries: [{ Id: "abc", Name: "Movies", CollectionType: "movies" }],
        ExpiresAt: "2026-09-15T12:00:00.0000000+00:00",
      }),
    );

    await lookupInvite(ORIGIN, "s3cr3t-token", { fetch: impl });

    expect(calls[0].url).toBe(`${ORIGIN}/stingstream/api/v1/invites/lookup`);
    expect(calls[0].url).not.toContain("s3cr3t-token");
    expect(calls[0].init?.method).toBe("POST");
    expect(bodyOf(calls[0].init).Token).toBe("s3cr3t-token");
  });

  test("what comes back is what the landing page shows", async () => {
    const { impl } = stubFetch(() =>
      json(200, {
        ServerName: "Dan's Attic",
        InvitedBy: "dan",
        Libraries: [
          { Id: "abc", Name: "Movies", CollectionType: "movies" },
          { Id: "def", Name: "TV", CollectionType: "tvshows" },
        ],
        ExpiresAt: "2026-09-15T12:00:00.0000000+00:00",
      }),
    );

    const invite = await lookupInvite(ORIGIN, "token", { fetch: impl });

    expect(invite.serverName).toBe("Dan's Attic");
    expect(invite.invitedBy).toBe("dan");
    expect(invite.libraries.map((l) => l.name)).toEqual(["Movies", "TV"]);
  });

  /**
   * The distinction `/join` is built on. A 404 is how a *group* invite code reaches this endpoint —
   * a base58 string no person invite has — and the route falls through to the group Join screen on
   * exactly this error kind. Collapsing the two would send everyone who was ever sent a group
   * invite to a dead end.
   */
  test("a token this server never minted is `unknown`, not an error to show", async () => {
    const { impl } = stubFetch(() => new Response(null, { status: 404 }));

    const error = await lookupInvite(ORIGIN, "a-group-code", {
      fetch: impl,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(InviteRequestError);
    expect((error as InviteRequestError).kind).toBe("unknown");
  });

  test("a spent invite is `spent`, and keeps the node's own sentence", async () => {
    const { impl } = stubFetch(() =>
      json(410, {
        Error:
          "This invite has already been used. Ask whoever sent it for a new one.",
      }),
    );

    const error = await lookupInvite(ORIGIN, "token", { fetch: impl }).catch(
      (e) => e,
    );

    expect((error as InviteRequestError).kind).toBe("spent");
    // The node's sentence, not ours: it is the half that says *which* of used, expired or
    // withdrawn, and the client has no way to know.
    expect((error as InviteRequestError).message).toContain(
      "already been used",
    );
  });

  test("a 410 with no readable body still says something useful", async () => {
    const { impl } = stubFetch(() => new Response("<html>", { status: 410 }));

    const error = await lookupInvite(ORIGIN, "token", { fetch: impl }).catch(
      (e) => e,
    );

    expect((error as InviteRequestError).kind).toBe("spent");
    expect((error as InviteRequestError).message.length).toBeGreaterThan(0);
  });

  test("nothing answering is `unreachable`, which is not the same as refused", async () => {
    const { impl } = stubFetch(() => {
      throw new TypeError("network");
    });

    const error = await lookupInvite(ORIGIN, "token", { fetch: impl }).catch(
      (e) => e,
    );

    expect((error as InviteRequestError).kind).toBe("unreachable");
  });
});

describe("acceptInvite", () => {
  test("the token, name and password all travel in the body", async () => {
    const { impl, calls } = stubFetch(() =>
      json(200, { AccessToken: "tok", User: { Id: "u1", Name: "mum" } }),
    );

    await acceptInvite(
      ORIGIN,
      { token: "s3cr3t", username: "mum", password: "hunter22" },
      { fetch: impl },
    );

    expect(calls[0].url).toBe(`${ORIGIN}/stingstream/api/v1/invites/accept`);
    expect(calls[0].url).not.toContain("s3cr3t");
    const sent = bodyOf(calls[0].init);
    expect(sent).toEqual({
      Token: "s3cr3t",
      Username: "mum",
      Password: "hunter22",
    });
  });

  test("a session comes back, so the app can go straight to the library", async () => {
    const { impl } = stubFetch(() =>
      json(200, { AccessToken: "tok", User: { Id: "u1", Name: "mum" } }),
    );

    const result = await acceptInvite(
      ORIGIN,
      { token: "s3cr3t", username: "mum", password: "hunter22" },
      { fetch: impl },
    );

    expect(result).toEqual({
      accessToken: "tok",
      userId: "u1",
      username: "mum",
    });
  });

  /**
   * The account exists by the time the body is being parsed, so a body that cannot be read is not
   * a reason to tell somebody their account was not created — they would try again and be told the
   * name is taken, by themselves. The caller signs in with the credentials it already has.
   */
  test("an unreadable body is not a failed sign-up", async () => {
    const { impl } = stubFetch(() => new Response("not json", { status: 200 }));

    const result = await acceptInvite(
      ORIGIN,
      { token: "s3cr3t", username: "mum", password: "hunter22" },
      { fetch: impl },
    );

    expect(result.username).toBe("mum");
    expect(result.accessToken).toBeNull();
  });

  test("a refused name keeps the node's own reason", async () => {
    const { impl } = stubFetch(() =>
      json(400, { Error: "That name is already taken on this server." }),
    );

    const error = await acceptInvite(
      ORIGIN,
      { token: "s3cr3t", username: "dan", password: "hunter22" },
      { fetch: impl },
    ).catch((e) => e);

    expect((error as InviteRequestError).kind).toBe("invalid");
    expect((error as InviteRequestError).message).toContain("already taken");
  });

  /**
   * The race that single-use exists to lose gracefully: a link forwarded to a group chat, opened
   * twice in the same second. The second person is told the invite is gone rather than shown a
   * generic failure they would keep retrying.
   */
  test("losing the race to somebody else is `spent`", async () => {
    const { impl } = stubFetch(() =>
      json(410, { Error: "This invite has already been used." }),
    );

    const error = await acceptInvite(
      ORIGIN,
      { token: "s3cr3t", username: "mum", password: "hunter22" },
      { fetch: impl },
    ).catch((e) => e);

    expect((error as InviteRequestError).kind).toBe("spent");
  });
});
