import { describe, expect, test } from "bun:test";
import { nextQuickConnectAction } from "./nextAction";

describe("nextQuickConnectAction", () => {
  test("an authenticated poll logs in", () => {
    expect(nextQuickConnectAction({ kind: "authenticated" })).toBe(
      "authenticate",
    );
  });

  test("a pending poll keeps waiting", () => {
    expect(nextQuickConnectAction({ kind: "pending" })).toBe("keep_waiting");
  });

  test("an expired code (HTTP 400) regenerates instead of giving up", () => {
    expect(nextQuickConnectAction({ kind: "expired" })).toBe("regenerate");
  });

  test("an unrecognised secret (HTTP 404) stops", () => {
    expect(nextQuickConnectAction({ kind: "not_found" })).toBe("stop");
  });
});
