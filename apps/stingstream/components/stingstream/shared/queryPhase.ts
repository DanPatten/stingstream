/**
 * Which of four things a react-query result is actually saying.
 *
 * `QueryState` used to ask two questions — is it loading, did it error — and render the children
 * for everything else. That leaves a third case unnamed: **a query that was never allowed to run.**
 * `enabled: false` (which every settings query does while `api` is null) reports
 * `status: "pending"`, `fetchStatus: "idle"`, and therefore `isLoading: false` **and**
 * `error: null`. Both branches miss, the children render, and a pane whose body is gated on a
 * draft it will never receive paints as an empty region with no heading and no explanation.
 *
 * That is not hypothetical. Dan's node was down and the Storage screen drew two labelled, empty
 * text fields: *"my server was down but it wasn't obvious as the frontend still worked."* The
 * fields were fine. The screen simply had nothing to say and said it silently.
 *
 * So "not going to get any data" is a fourth *state*, not a fourth thing for each call site to
 * remember, and it is named here. `isPending && fetchStatus === "idle"` is react-query's own
 * vocabulary for it.
 *
 * Kept as a pure function in its own module because `ScreenState.tsx` imports react-native and
 * this app has no component-rendering tests at all — anything that must be pinned by a test has
 * to be pure. See `queryPhase.test.ts`.
 *
 * Still to convert: the sections that `return null` on a missing draft *before* reaching any
 * `QueryState` at all — `DownloadClientsSection`, `NamingSection`, `NotificationsSection`. They
 * have the same failure and cannot be fixed from here.
 */
export type QueryPhase = "loading" | "error" | "unavailable" | "ready";

export interface QueryPhaseInput {
  isLoading: boolean;
  error: unknown;
  /** react-query v5. Absent from older call sites, which then behave exactly as before. */
  isPending?: boolean;
  fetchStatus?: "fetching" | "paused" | "idle";
}

export function queryPhase({
  isLoading,
  error,
  isPending,
  fetchStatus,
}: QueryPhaseInput): QueryPhase {
  // An error we have is worth more than an explanation we inferred: a query that failed and was
  // then disabled still knows why it failed, and that message is the useful one.
  if (error) return "error";
  if (isLoading) return "loading";
  if (isPending && fetchStatus === "idle") return "unavailable";
  return "ready";
}
