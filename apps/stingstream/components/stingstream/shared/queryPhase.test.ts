import { describe, expect, test } from "bun:test";
import { queryPhase } from "./queryPhase";

describe("queryPhase", () => {
  test("a query that never ran says the server is not answering, not nothing", () => {
    // The reported bug. `enabled: false` while `api` is null reports pending-and-idle, which is
    // neither loading nor an error, so the old two-branch QueryState rendered its children — and
    // a pane gated on a draft it will never receive drew an empty region. Dan saw two labelled,
    // empty fields on Storage and no hint his node was down.
    expect(
      queryPhase({
        isLoading: false,
        error: null,
        isPending: true,
        fetchStatus: "idle",
      }),
    ).toBe("unavailable");
  });

  test("a request in flight is loading, not unavailable", () => {
    expect(
      queryPhase({
        isLoading: true,
        error: null,
        isPending: true,
        fetchStatus: "fetching",
      }),
    ).toBe("loading");
  });

  test("a refetch that has not resolved yet is still loading", () => {
    // isLoading is isPending && isFetching, so this is the first-load-in-progress shape.
    expect(
      queryPhase({
        isLoading: false,
        error: null,
        isPending: true,
        fetchStatus: "fetching",
      }),
    ).toBe("ready");
  });

  test("an error outranks being unavailable", () => {
    // A query that failed and was then disabled still knows why it failed, and "could not reach
    // the server: ECONNREFUSED" tells the reader more than the generic unavailable copy.
    expect(
      queryPhase({
        isLoading: false,
        error: new Error("connect ECONNREFUSED"),
        isPending: true,
        fetchStatus: "idle",
      }),
    ).toBe("error");
  });

  test("a request that never reached the node is unavailable, not an error", () => {
    // Settings -> Logs & status showed "Something went wrong / Failed to fetch" indefinitely for a
    // node that was healthy: the `/healthz` poll went cross-origin after the side door switched
    // the session, the browser refused the response, and every error landed in ErrorState. A
    // browser internal is not something to put on a screen, and the node was not broken.
    for (const message of [
      "Failed to fetch", // Chrome, Edge
      "NetworkError when attempting to fetch resource.", // Firefox
      "Load failed", // Safari
      "Network request failed", // React Native
    ]) {
      expect(
        queryPhase({
          isLoading: false,
          error: new TypeError(message),
          isPending: false,
          fetchStatus: "idle",
        }),
      ).toBe("unavailable");
    }
  });

  test("a real failure from the server is still an error", () => {
    // The branch above must not swallow everything: a 500 with a message the reader can act on
    // belongs in ErrorState, where that message is shown.
    expect(
      queryPhase({
        isLoading: false,
        error: new Error("GET /settings -> 500"),
        isPending: false,
        fetchStatus: "idle",
      }),
    ).toBe("error");
    // A TypeError that is not a fetch failure is a bug in the app, and must not be disguised.
    expect(
      queryPhase({
        isLoading: false,
        error: new TypeError("x.map is not a function"),
        isPending: false,
        fetchStatus: "idle",
      }),
    ).toBe("error");
  });

  test("data in hand is ready", () => {
    expect(
      queryPhase({
        isLoading: false,
        error: null,
        isPending: false,
        fetchStatus: "idle",
      }),
    ).toBe("ready");
  });

  test("a call site passing only the old two props behaves exactly as it used to", () => {
    // ~20 QueryState callers were written before this existed and pass neither isPending nor
    // fetchStatus. None of them may start rendering an unavailable state they never asked for.
    expect(queryPhase({ isLoading: true, error: null })).toBe("loading");
    expect(queryPhase({ isLoading: false, error: null })).toBe("ready");
    expect(queryPhase({ isLoading: false, error: new Error("x") })).toBe(
      "error",
    );
  });
});
