import { afterEach, describe, expect, test } from "bun:test";
import {
  type AccountServer,
  AccountError,
  fetchMe,
  serverOrigin,
  sessionOn,
  setShare,
  signIn,
} from "./accountsApi";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Capture what was sent, and answer with what the far end would. */
const mock = (status: number, body: unknown, seen: { req?: RequestInit; url?: string } = {}) => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.url = String(url);
    seen.req = init;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as Response;
  }) as typeof fetch;
  return seen;
};

const server = (over: Partial<AccountServer> = {}): AccountServer => ({
  node: "n1",
  name: "Attic",
  address: "",
  owned: true,
  ...over,
});

describe("signing in", () => {
  test("returns the token and re-shapes the service's snake_case", () => {
    mock(200, {
      token: "t",
      expires_in: 43200,
      account: "a1",
      username: "dan",
    });
    return signIn("https://accounts.example", "dan", "pw").then((s) => {
      expect(s).toEqual({
        token: "t",
        expiresIn: 43200,
        account: "a1",
        username: "dan",
      });
    });
  });

  /**
   * The service writes its refusals to be read by a person, and deliberately says the same thing
   * for a wrong password as for an unknown username. Passing it through unchanged is what keeps
   * that property intact all the way to the screen.
   */
  test("shows the message the far end wrote", async () => {
    mock(401, { error: "that username and password do not match" });
    await expect(signIn("https://accounts.example", "dan", "nope")).rejects.toThrow(
      "that username and password do not match",
    );
  });

  test("a reply that is not JSON still produces something readable", async () => {
    mock(502, "<html>Bad Gateway</html>");
    const err = await signIn("https://accounts.example", "dan", "pw").catch((e) => e);
    expect(err).toBeInstanceOf(AccountError);
    expect(String(err)).not.toContain("undefined");
  });

  test("a trailing slash on the service does not double up", async () => {
    const seen = mock(200, { token: "t", expires_in: 1, account: "a", username: "u" });
    await signIn("https://accounts.example/", "dan", "pw");
    expect(seen.url).toBe("https://accounts.example/accounts/v1/login");
  });
});

describe("reading the account", () => {
  test("sends the token as a bearer", async () => {
    const seen = mock(200, { account: "a1", username: "dan", servers: [] });
    await fetchMe("https://accounts.example", "t");
    expect((seen.req?.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });
});

describe("sharing", () => {
  test("share and revoke differ only by method, so one screen drives both", async () => {
    const shared = mock(204, {});
    await setShare("https://accounts.example", "t", { node: "n1", username: "alice" }, "share");
    expect(shared.req?.method).toBe("PUT");

    const revoked = mock(204, {});
    await setShare("https://accounts.example", "t", { node: "n1", username: "alice" }, "revoke");
    expect(revoked.req?.method).toBe("DELETE");
  });

  test("no libraries means every library, which is what the service reads an empty list as", async () => {
    const seen = mock(204, {});
    await setShare("https://accounts.example", "t", { node: "n1", username: "alice" }, "share");
    expect(JSON.parse(String(seen.req?.body)).libraries).toEqual([]);
  });
});

describe("signing in to a server", () => {
  /**
   * The property the whole design rests on: this call goes to the *node*, not to the account
   * service, so it works with the service switched off.
   */
  test("goes to the server, not to the account service", async () => {
    const seen = mock(200, {});
    await sessionOn("https://media.example.com", "t");
    expect(seen.url).toBe(
      "https://media.example.com/stingstream/api/v1/accounts/session",
    );
  });
});

describe("where a server can be reached", () => {
  test("an address is used as its origin", () => {
    expect(serverOrigin(server({ address: "https://media.example.com/" }))).toBe(
      "https://media.example.com",
    );
  });

  /**
   * Most people have no domain, so this is the common case rather than an error. The UI shows it
   * rather than hiding the server: a shared library you cannot open is worth explaining, and
   * showing it as offline would send somebody looking at the wrong thing.
   */
  test("no address is an ordinary answer, not a failure", () => {
    expect(serverOrigin(server({ address: "" }))).toBeNull();
    expect(serverOrigin(server({ address: "   " }))).toBeNull();
  });
});
