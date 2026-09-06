/**
 * Pure decision logic for what a "sign in with a code" screen should do next,
 * given how the last `QuickConnect/Connect` poll came back.
 *
 * Extracted out of `JellyfinProvider.tsx` so the one branch that actually
 * matters here -- that an expired code (HTTP 400) means "get a new one", not
 * "give up and show the user an error" -- has a test that does not need a
 * mocked Jellyfin API or a fake timer for the poll interval.
 */

export type QuickConnectPollOutcome =
  | { kind: "authenticated" }
  | { kind: "pending" }
  /** The server answered `QuickConnect/Connect` with HTTP 400: the code timed out. */
  | { kind: "expired" }
  /** The server answered HTTP 404: it does not recognise this secret at all. */
  | { kind: "not_found" };

export type QuickConnectNextAction =
  | "authenticate"
  | "keep_waiting"
  | "regenerate"
  | "stop";

export function nextQuickConnectAction(
  outcome: QuickConnectPollOutcome,
): QuickConnectNextAction {
  switch (outcome.kind) {
    case "authenticated":
      return "authenticate";
    case "pending":
      return "keep_waiting";
    case "expired":
      return "regenerate";
    case "not_found":
      return "stop";
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
