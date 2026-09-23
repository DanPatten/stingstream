/**
 * How the app waits for a node that is there but not ready.
 *
 * Shared by the sign-in screen's auto-connect (`components/login/LoginScreen.tsx`) and the
 * signed-in readiness watch (`providers/NetworkStatusProvider.tsx`), because they are one
 * policy: a returning browser and a fresh one are waiting for the same Jellyfin to come up.
 */

/**
 * How long "Starting your server" shows before it becomes the stalled card with Try again.
 *
 * Not a guess: `tools/ui-startup.ps1` allows the node **40 s** to become healthy with the download
 * managers off and **90 s** with them on, so giving up sooner is giving up on a server that is
 * doing exactly what it is supposed to.
 */
export const SERVER_STARTING_BUDGET_MS = 90_000;

/** The first retry after a "starting" answer. */
export const SERVER_STARTING_FIRST_DELAY_MS = 1_000;

/** The backoff cap. Matches the `Retry-After: 5` the gateway sends with its own 503. */
export const SERVER_STARTING_MAX_DELAY_MS = 5_000;

/**
 * How often to keep asking once the wait has stalled, or once nothing answers at all.
 *
 * The screen still moves on by itself if the server does come up; it just stops asking as often.
 */
export const SERVER_QUIET_POLL_MS = 15_000;

/**
 * How long, on a page the node itself just served, "nothing answered" still counts as starting.
 *
 * Web only. A browser that loaded its bundle from the gateway a moment ago has proof the node was
 * up; a refused connection right after is the node restarting (an install over an older version
 * restarts the service after opening the page), not a node that is gone. A phone has no such
 * proof, and its downloads are more use to it than a spinner, so it gets no grace.
 */
export const SERVER_UNREACHABLE_GRACE_MS = 20_000;
