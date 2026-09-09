import { beforeAll, describe, expect, test } from "bun:test";
import i18n from "i18next";
import en from "../../translations/en.json";
import {
  createAdmin,
  getSetupState,
  isSetupFormValid,
  looksLikeHostname,
  PASSWORD_MIN_LENGTH,
  SetupRequestError,
  USERNAME_MAX_LENGTH,
  validateSetupForm,
} from "./setup";

const ORIGIN = "http://localhost:8790";

/**
 * The real catalogue, on the real i18next instance `setup.ts` imports `t` from.
 *
 * Without this every message comes back as the empty string and the assertions below pass
 * vacuously — and, more usefully, this makes the spec fail if one of the keys it names is ever
 * removed from `en.json`.
 */
beforeAll(async () => {
  await i18n.init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
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

describe("validateSetupForm", () => {
  const good = { username: "dan", password: "hunter22", confirm: "hunter22" };

  test("a good form has nothing to say", () => {
    const errors = validateSetupForm(good);
    expect(errors).toEqual({});
    expect(isSetupFormValid(errors)).toBe(true);
  });

  test("an empty username is the first thing anyone will hit", () => {
    const errors = validateSetupForm({
      username: "   ",
      password: "",
      confirm: "",
    });
    expect(errors.username).toBeTruthy();
    expect(errors.password).toBeTruthy();
    expect(isSetupFormValid(errors)).toBe(false);
  });

  test("letters, digits, dots, underscores and dashes are the username alphabet", () => {
    for (const username of ["dan", "d.an_1", "a-b", "0"]) {
      expect(validateSetupForm({ ...good, username }).username).toBeUndefined();
    }
    for (const username of ["dan patten", "dan@home", "réal", "d/n"]) {
      expect(validateSetupForm({ ...good, username }).username).toBeTruthy();
    }
  });

  test("the username length limit is Core's", () => {
    const at = "a".repeat(USERNAME_MAX_LENGTH);
    expect(
      validateSetupForm({ ...good, username: at }).username,
    ).toBeUndefined();
    expect(
      validateSetupForm({ ...good, username: `${at}a` }).username,
    ).toBeTruthy();
  });

  test("the password floor is Core's", () => {
    const short = "a".repeat(PASSWORD_MIN_LENGTH - 1);
    const ok = "a".repeat(PASSWORD_MIN_LENGTH);
    expect(
      validateSetupForm({ username: "dan", password: short, confirm: short })
        .password,
    ).toBeTruthy();
    expect(
      validateSetupForm({ username: "dan", password: ok, confirm: ok })
        .password,
    ).toBeUndefined();
  });

  test("a mismatched confirmation is reported on the confirm field", () => {
    const errors = validateSetupForm({
      username: "dan",
      password: "hunter22",
      confirm: "hunter23",
    });
    expect(errors.confirm).toBeTruthy();
    expect(errors.password).toBeUndefined();
  });

  test("a too-short password does not also complain about the confirmation", () => {
    // One mistake, one message: complaining twice reads as two separate problems.
    const errors = validateSetupForm({
      username: "dan",
      password: "short",
      confirm: "",
    });
    expect(errors.password).toBeTruthy();
    expect(errors.confirm).toBeUndefined();
  });
});

describe("getSetupState", () => {
  test("reads Core's three booleans", async () => {
    const { impl, calls } = stubFetch(() =>
      json(200, { Pending: true, Loopback: true, TrustedPeer: true }),
    );

    expect(await getSetupState(ORIGIN, { fetch: impl })).toEqual({
      known: true,
      pending: true,
      loopback: true,
      trustedPeer: true,
    });
    expect(calls[0].url).toBe(
      "http://localhost:8790/stingstream/api/v1/setup/state",
    );
  });

  test("trustedPeer is Core's own SetupGate.IsTrustedPeer answer, wider than loopback", async () => {
    // A LAN peer: Loopback false, TrustedPeer true (Dan, 2026-09-07: "by IP is better").
    const { impl } = stubFetch(() =>
      json(200, { Pending: true, Loopback: false, TrustedPeer: true }),
    );

    expect(await getSetupState(ORIGIN, { fetch: impl })).toEqual({
      known: true,
      pending: true,
      loopback: false,
      trustedPeer: true,
    });
  });

  test("missing or non-boolean fields read as false, never as pending", () => {
    // Showing "create your account" to somebody who already has one is the worse mistake.
    const { impl } = stubFetch(() => json(200, { Pending: "yes" }));
    return expect(getSetupState(ORIGIN, { fetch: impl })).resolves.toEqual({
      known: true,
      pending: false,
      loopback: false,
      trustedPeer: false,
    });
  });

  test("an older Core with no TrustedPeer field falls back to Loopback, not to false", async () => {
    // The exact bug this guards: `TrustedPeer === true` on an absent field reads as "not
    // trusted" even from loopback, which downgrades an old server's own answer -- it used to gate
    // on `Loopback` alone, and a page talking to it must still get the setup screen from home.
    const { impl } = stubFetch(() =>
      json(200, { Pending: true, Loopback: true }),
    );

    expect(await getSetupState(ORIGIN, { fetch: impl })).toEqual({
      known: true,
      pending: true,
      loopback: true,
      trustedPeer: true,
    });
  });

  // `known: false` is the whole point. A 404 has two causes that the status cannot tell apart --
  // a node too old to have the routes, and a **new** node whose gateway has not registered its
  // Jellyfin child yet -- and reading the second as "setup is done" is what put an address form
  // in front of somebody on a cold node. `decidePhase` resolves it from the marker instead.
  test("a 404 is reported as no answer at all, not as not-pending", async () => {
    const { impl } = stubFetch(() => new Response(null, { status: 404 }));

    expect(await getSetupState(ORIGIN, { fetch: impl })).toEqual({
      known: false,
      pending: false,
      loopback: false,
      trustedPeer: false,
    });
  });

  test("a node still starting is retried, and the later answer wins", async () => {
    let n = 0;
    const { impl, calls } = stubFetch(() => {
      n += 1;
      return n < 3
        ? new Response(null, { status: 503 })
        : json(200, { Pending: true, Loopback: false, TrustedPeer: true });
    });

    expect(
      await getSetupState(ORIGIN, { fetch: impl, retryDelayMs: 0 }),
    ).toEqual({
      known: true,
      pending: true,
      loopback: false,
      trustedPeer: true,
    });
    expect(calls).toHaveLength(3);
  });

  test("a node that never answers throws unreachable, once the tries run out", async () => {
    const { impl, calls } = stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });

    const error = await getSetupState(ORIGIN, {
      fetch: impl,
      attempts: 2,
      retryDelayMs: 0,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(SetupRequestError);
    expect((error as SetupRequestError).kind).toBe("unreachable");
    expect(calls).toHaveLength(2);
  });

  test("a 200 that is not JSON is a server error, not a pending node", async () => {
    const { impl } = stubFetch(
      () => new Response("<html>hello</html>", { status: 200 }),
    );

    const error = await getSetupState(ORIGIN, {
      fetch: impl,
      attempts: 1,
    }).catch((e) => e);
    expect((error as SetupRequestError).kind).toBe("server");
  });
});

describe("createAdmin", () => {
  test("posts Core's PascalCase body and returns the session", async () => {
    const { impl, calls } = stubFetch(() =>
      json(200, {
        AccessToken: "tok",
        User: { Id: "uid", Name: "dan" },
      }),
    );

    const created = await createAdmin(
      ORIGIN,
      { username: "dan", password: "hunter22" },
      { fetch: impl },
    );

    expect(created).toEqual({
      accessToken: "tok",
      userId: "uid",
      username: "dan",
    });
    expect(calls[0].url).toBe(
      "http://localhost:8790/stingstream/api/v1/setup/admin",
    );
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      Username: "dan",
      Password: "hunter22",
    });
  });

  test("400 carries Core's own sentence through to the form", async () => {
    const { impl } = stubFetch(() =>
      json(400, { Error: "That name is already taken." }),
    );

    const error = await createAdmin(
      ORIGIN,
      { username: "dan", password: "hunter22" },
      { fetch: impl },
    ).catch((e) => e);

    expect(error).toBeInstanceOf(SetupRequestError);
    expect((error as SetupRequestError).kind).toBe("invalid");
    expect((error as SetupRequestError).message).toBe(
      "That name is already taken.",
    );
  });

  test("400 with no sentence still says something a person can read", async () => {
    const { impl } = stubFetch(() => new Response(null, { status: 400 }));

    const error = await createAdmin(
      ORIGIN,
      { username: "dan", password: "hunter22" },
      { fetch: impl },
    ).catch((e) => e);

    expect((error as SetupRequestError).kind).toBe("invalid");
    expect((error as SetupRequestError).message.length).toBeGreaterThan(0);
  });

  test("409 with setup no longer pending is somebody already claimed this node", async () => {
    const { impl } = stubFetch((url) =>
      url.endsWith("/setup/state")
        ? json(200, { Pending: false, Loopback: true })
        : json(409, { Error: "Already set up." }),
    );

    const error = await createAdmin(
      ORIGIN,
      { username: "dan", password: "hunter22" },
      { fetch: impl, retryDelayMs: 0 },
    ).catch((e) => e);

    expect((error as SetupRequestError).kind).toBe("not_pending");
  });

  test("409 while setup is still pending means the node is still starting", async () => {
    // Core creates the bootstrap account at the front of its wiring pass, so a submit that beats
    // it gets a 409 that means "not yet". Reading that as "already claimed" would send somebody
    // to a password prompt for an account that does not exist — the exact opposite answer.
    let admins = 0;
    const { impl } = stubFetch((url) => {
      if (url.endsWith("/setup/state")) {
        return json(200, { Pending: true, Loopback: true });
      }
      admins += 1;
      return json(409, {
        Error: "This server is still starting up; try again in a moment.",
      });
    });

    const error = await createAdmin(
      ORIGIN,
      { username: "dan", password: "hunter22" },
      { fetch: impl, attempts: 3, retryDelayMs: 0 },
    ).catch((e) => e);

    expect((error as SetupRequestError).kind).toBe("starting");
    // Core's own sentence, not ours: it is the one that knows what it is waiting for.
    expect((error as SetupRequestError).message).toBe(
      "This server is still starting up; try again in a moment.",
    );
    expect(admins).toBe(3);
  });

  test("a node that finishes starting mid-retry gets the account", async () => {
    let admins = 0;
    const { impl } = stubFetch((url) => {
      if (url.endsWith("/setup/state")) {
        return json(200, { Pending: true, Loopback: true });
      }
      admins += 1;
      return admins < 3
        ? json(409, { Error: "This server is still starting up." })
        : json(200, { AccessToken: "tok", User: { Id: "uid", Name: "dan" } });
    });

    expect(
      await createAdmin(
        ORIGIN,
        { username: "dan", password: "hunter22" },
        { fetch: impl, retryDelayMs: 0 },
      ),
    ).toEqual({ accessToken: "tok", userId: "uid", username: "dan" });
    expect(admins).toBe(3);
  });

  test("a state endpoint that will not answer errs on the side of retrying", async () => {
    // Unknown is not "already claimed": a first-run screen that gives up on a node it cannot
    // question strands the only person who can set it up.
    const { impl } = stubFetch((url) =>
      url.endsWith("/setup/state")
        ? new Response(null, { status: 503 })
        : json(409, {}),
    );

    const error = await createAdmin(
      ORIGIN,
      { username: "dan", password: "hunter22" },
      { fetch: impl, attempts: 1 },
    ).catch((e) => e);

    expect((error as SetupRequestError).kind).toBe("starting");
  });

  test("a refused password is not retried", async () => {
    let admins = 0;
    const { impl } = stubFetch(() => {
      admins += 1;
      return json(400, { Error: "That name is already taken." });
    });

    await createAdmin(
      ORIGIN,
      { username: "dan", password: "hunter22" },
      { fetch: impl, retryDelayMs: 0 },
    ).catch(() => {});

    expect(admins).toBe(1);
  });

  test("404 is the gateway refusing an off-machine caller", async () => {
    // LOOPBACK_ONLY_PREFIXES answers "no such route" rather than "forbidden" on purpose, so a
    // remote browser cannot even learn the route exists. From here it means one thing only.
    const { impl } = stubFetch(() => new Response(null, { status: 404 }));

    const error = await createAdmin(
      ORIGIN,
      { username: "dan", password: "hunter22" },
      { fetch: impl },
    ).catch((e) => e);

    expect((error as SetupRequestError).kind).toBe("not_local");
  });

  test("nothing answering is unreachable", async () => {
    const { impl } = stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });

    const error = await createAdmin(
      ORIGIN,
      { username: "dan", password: "hunter22" },
      { fetch: impl },
    ).catch((e) => e);

    expect((error as SetupRequestError).kind).toBe("unreachable");
  });

  test("a 200 with an unreadable body still counts as created", async () => {
    // The account exists on the server either way; reporting failure would leave the user staring
    // at a setup screen that now answers 409.
    const { impl } = stubFetch(() => new Response("", { status: 200 }));

    expect(
      await createAdmin(
        ORIGIN,
        { username: "dan", password: "hunter22" },
        { fetch: impl },
      ),
    ).toEqual({ accessToken: null, userId: null, username: "dan" });
  });
});

describe("looksLikeHostname", () => {
  // The exact bug this exists to catch: Jellyfin's `ServerName` defaults to the machine's own
  // hostname, and "Sign in to PLEXPC" / "Sign in to DESKTOP-4F2K9QL" is what a person actually saw.
  test.each([
    "PLEXPC",
    "DESKTOP-4F2K9QL",
    "my-nas.local",
    "stingstream.example.com",
    "192.168.1.5",
    "0",
    "",
    "   ",
  ])("%s reads as a hostname or default", (name) => {
    expect(looksLikeHostname(name)).toBe(true);
  });

  test.each(["Dan's place", "Home Theater", "StingStream", "Living Room"])(
    "%s is a name somebody chose",
    (name) => {
      expect(looksLikeHostname(name)).toBe(false);
    },
  );
});
