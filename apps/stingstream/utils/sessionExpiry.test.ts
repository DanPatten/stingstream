import { afterEach, describe, expect, test } from "bun:test";
import {
  onSessionExpired,
  reportSessionExpired,
  SessionExpiredError,
} from "./sessionExpiry";

// The registry is module state, so a test that registers without retracting leaks its handler into
// whatever runs next.
const cleanups: (() => void)[] = [];
const register = (latest: () => (() => void) | undefined) => {
  const stop = onSessionExpired(latest);
  cleanups.push(stop);
  return stop;
};

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("reportSessionExpired", () => {
  test("runs the handler the provider holds now, not the one it held then", () => {
    // `handleSessionExpired` closes over `clearSessionState`, which closes over the query client
    // and the plugin-settings setter. Resolving at registration means an account switch tears down
    // the previous account's state instead of the current one's.
    const calls: string[] = [];
    let current = () => calls.push("first");

    register(() => current);

    reportSessionExpired();
    current = () => calls.push("second");
    reportSessionExpired();

    expect(calls).toEqual(["first", "second"]);
  });

  test("does nothing when nobody is signed in", () => {
    // The provider only registers while there is an authenticated api, so a 401 from a screen that
    // is still unmounting, or from the login screen itself, arrives with an empty registry. That is
    // the normal state and must not take the app down.
    expect(() => reportSessionExpired()).not.toThrow();
  });

  test("survives a registration that has nothing to hand back yet", () => {
    register(() => undefined);

    expect(() => reportSessionExpired()).not.toThrow();
  });

  test("stops calling the handler once unsubscribed", () => {
    const calls: string[] = [];
    const stop = register(() => () => calls.push("ran"));

    stop();
    reportSessionExpired();

    expect(calls).toEqual([]);
  });

  test("a re-registered handler survives the old one's cleanup", () => {
    // The provider's effect re-runs whenever the api or the handler identity changes, and React
    // runs the new effect before the old cleanup in some orderings. A cleanup that cleared the
    // registry unconditionally would leave the app with no handler at all.
    const calls: string[] = [];
    const stopFirst = onSessionExpired(() => () => calls.push("first"));
    const stopSecond = onSessionExpired(() => () => calls.push("second"));

    stopFirst();
    reportSessionExpired();
    stopSecond();

    expect(calls).toEqual(["second"]);
  });
});

describe("SessionExpiredError", () => {
  test("is an Error, so a query's generic catch still works", () => {
    const error = new SessionExpiredError("Your session has expired.");

    expect(error).toBeInstanceOf(Error);
    expect(error.expired).toBe(true);
    expect(error.message).toBe("Your session has expired.");
  });
});
