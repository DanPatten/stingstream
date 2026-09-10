/**
 * Request-search policy, shared by the two screens that run one.
 *
 * `FindSection` is the phone and web search on the Requests tab; `DiscoverSection` is the
 * television's, which is a separate screen with a remote control to type on. They ask the node the
 * same question and so have to agree about when to ask it — see `docs/conventions/constants.md`.
 */

/**
 * How long to wait after the last keystroke before asking the node.
 *
 * Every call is a metadata lookup per manager plus a group-index scan per result, so this is real
 * work on the server rather than a render. Long enough that typing a title is one search, short
 * enough not to feel stuck.
 */
export const REQUEST_SEARCH_DEBOUNCE_MS = 400;

/**
 * Below this the search does not run at all (`useRequestSearch`'s own `enabled` is `> 2`).
 *
 * Two characters would be a real search — "Up", "It" and "Us" are all films somebody will type —
 * but one matches everything ever made, and the node pays for the difference.
 */
export const REQUEST_SEARCH_MIN_LENGTH = 3;

/**
 * Public-domain titles offered as chips before anything has been typed.
 *
 * These are search *terms*, not library content: pressing one runs a real metadata lookup, so a
 * chip finds whatever the node's own managers return. They stand in for a feed — there is no
 * trending or recently-requested endpoint to build one from, and a fabricated row would be worse
 * than none. Six, per the design: enough to suggest a spread of films and one series without
 * turning the empty state into a wall of buttons.
 */
export const REQUEST_EXAMPLE_SEARCHES = [
  "Sintel",
  "Big Buck Bunny",
  "Nosferatu",
  "The Beverly Hillbillies",
  "Tears of Steel",
  "Elephants Dream",
] as const;
