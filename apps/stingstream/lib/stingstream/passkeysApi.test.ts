import { describe, expect, test } from "bun:test";
import { readSession } from "./passkeysApi";

describe("readSession", () => {
  /**
   * The bug this pins: an administrator signed in with a passkey and Settings came up with every
   * administrator section missing until a reload. The session was adopted with a hand-built
   * `{Id, Name}`, and `Policy` — which everything administrator-only reads — was thrown away.
   */
  test("keeps the whole user, Policy included", () => {
    const session = readSession({
      AccessToken: "token",
      User: {
        Id: "user-1",
        Name: "dan",
        Policy: { IsAdministrator: true },
      },
    });

    expect(session.accessToken).toBe("token");
    expect(session.userId).toBe("user-1");
    expect(session.username).toBe("dan");
    expect(session.user?.Policy?.IsAdministrator).toBe(true);
  });

  test("a body with no user yields no user rather than an empty one", () => {
    const session = readSession({ AccessToken: "token" });
    expect(session.user).toBeNull();
    expect(session.userId).toBeNull();
  });
});
