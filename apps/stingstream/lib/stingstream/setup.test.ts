import { beforeAll, describe, expect, test } from "bun:test";
import i18n from "i18next";
import en from "../../translations/en.json";
import {
  createAdmin,
  getSetupState,
  isSetupFormValid,
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
  test("reads Core's two booleans", async () => {
    const { impl, calls } = stubFetch(() =>
      json(200, { Pending: true, Loopback: true }),
    );

    expect(await getSetupState(ORIGIN, { fetch: impl })).toEqual({
      pending: true,
      loopback: true,
    });
    expect(calls[0].url).toBe(
      "http://localhost:8790/stingstream/api/v1/setup/state",
    );
  });

  test("missing or non-boolean fields read as false, never as pending", () => {
    // Showing "create your account" to somebody who already has one is the worse mistake.
    const { impl } = stubFetch(() => json(200, { Pending: "yes" }));
    return expect(getSetupState(ORIGIN, { fetch: impl })).resolves.toEqual({
      pending: false,
      loopback: false,
    });
  });

  test("404 means not pending — an older node has no setup routes at all", async () => {
    const { impl } = stubFetch(() => new Response(null, { status: 404 }));

    expect(await getSetupState(ORIGIN, { fetch: impl })).toEqual({
      pending: false,
      loopback: false,
    });
  });

  test("a node still starting is retried, and the later answer wins", async () => {
    let n = 0;
    const { impl, calls } = stubFetch(() => {
      n += 1;
      return n < 3
        ? new Response(null, { status: 503 })
        : json(200, { Pending: true, Loopback: false });
    });

    expect(
      await getSetupState(ORIGIN, { fetch: impl, retryDelayMs: 0 }),
    ).toEqual({ pending: true, loopback: false });
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

  test("409 is somebody already claimed this node", async () => {
    const { impl } = stubFetch(() => json(409, { Error: "Already set up." }));

    const error = await createAdmin(
      ORIGIN,
      { username: "dan", password: "hunter22" },
      { fetch: impl },
    ).catch((e) => e);

    expect((error as SetupRequestError).kind).toBe("not_pending");
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
