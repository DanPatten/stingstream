/**
 * Which card the one pre-session screen shows, decided in one pure function.
 *
 * This lives outside `LoginScreen` because it is the piece that was wrong, and being wrong here
 * is expensive: a browser that a node served its own bundle to was shown **"Connect to your
 * server"**, with an address field and a saved entry for the address it was already at. Dan,
 * looking at it: *"the url your connecting to IS THE FUCKING server"*.
 *
 * So the rule this file exists to hold is one line long, and it is pinned by a test rather than
 * by a comment: **when a node served the page, the address form is not a reachable answer.**
 * There is nothing to ask. If the node cannot be reached yet, that is a node that is still
 * starting, and the honest card says so and keeps trying.
 */

/**
 * Not routes. The whole flow lives at `/login` and always did; what changes is state.
 *
 * - `connecting` — the first moment, before anything has answered.
 * - `starting` — the node is there and not ready. It says so and retries itself.
 * - `welcome` / `setupElsewhere` — a node with no account yet, claimable from here or not.
 * - `setup` — the admin-account form. **Only reachable from `welcome`**, never decided here:
 *   `decidePhase` answers the question "what is true of this server", and which of first run's two
 *   pages you are on is a question about the person, not the server.
 * - `signIn` — the ordinary card.
 * - `serverForm` — "which server?", and **only** where that question is honest: a phone, a
 *   television, a bundle opened from something that is not a node.
 */
export type Phase =
  | "connecting"
  | "starting"
  | "welcome"
  | "setup"
  | "setupElsewhere"
  | "signIn"
  | "serverForm";

/** What the page's own node marker said, as much of it as the decision uses. */
export interface PhaseNodeContext {
  /**
   * The gateway's `runtime.json` view of first-run: `true` while nobody has claimed the node,
   * `null` from a node too old to say (its marker has no such field), which is not `false`.
   */
  setupPending: boolean | null;
  /** Whether this page's own address is one the node would let create an account. */
  trustedPeer: boolean;
}

/** What `setup/state` said, or as much of it as the decision uses. */
export interface PhaseSetupState {
  /** False when the route 404'd — see `SetupState.known`. Not an answer. */
  known: boolean;
  pending: boolean;
  trustedPeer: boolean;
}

export interface PhaseInputs {
  /** The node marker, or null when nothing that looks like a node served this bundle. */
  context: PhaseNodeContext | null;
  /** Whether the app is now pointed at a server that answered. */
  connected: boolean;
  /** `setup/state`'s answer, or null when it could not be asked at all. */
  setup: PhaseSetupState | null;
}

export interface PhaseDecision {
  phase: Phase;
  /**
   * True when a setup card is being shown on the marker's word alone, because the node itself
   * never answered. The screen says so rather than pretending it checked.
   */
  unreachable: boolean;
}

/**
 * Pick the card.
 *
 * The order matters and each step is load-bearing:
 *
 * 1. **No node served this page** — the address question is the only honest first one.
 * 2. **The node answered** — it is the authority on whether it has an account. `setup/state` runs
 *    the same `SetupGate.IsTrustedPeer` check that actually gates `setup/admin`, against the real
 *    socket peer rather than a hostname string, so its `trustedPeer` beats the marker's.
 * 3. **It did not answer, or 404'd** — the marker is what is left, and it is better than a guess.
 *    A node that says it is unclaimed is unclaimed; a 404 from a gateway that has not registered
 *    its Jellyfin child yet is not evidence that somebody already created an account.
 *
 * And in every branch below the first, an unreachable server is `starting`, never `serverForm`.
 *
 * "Needs an account and you may create it" answers `welcome`, not `setup`. Both mean the same
 * thing about the server; which of first run's two pages is showing is the screen's own state, and
 * putting it here would make a re-decision — a Retry, say — throw away the page somebody had
 * already moved past.
 */
export function decidePhase({
  context,
  connected,
  setup,
}: PhaseInputs): PhaseDecision {
  if (!context) {
    return { phase: "serverForm", unreachable: false };
  }

  // Reachability, once, so the two "no account here yet" branches below cannot disagree.
  const reached: Phase = connected ? "signIn" : "starting";

  if (setup?.known) {
    if (!setup.pending) return { phase: reached, unreachable: false };
    return {
      phase: setup.trustedPeer ? "welcome" : "setupElsewhere",
      unreachable: false,
    };
  }

  if (context.setupPending === true) {
    return {
      phase: context.trustedPeer ? "welcome" : "setupElsewhere",
      // A 404 is an answer of sorts — the node is up, it just has no route. Silence is not.
      unreachable: setup === null,
    };
  }

  return { phase: reached, unreachable: false };
}
