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
 * How many season chips to draw when the node did not say how many a show has.
 *
 * `RequestSearchResult.seasonCount` carries the real number, off the same lookup that produced the
 * row, so this is only reached on a node built before that field existed. Generous on purpose: the
 * node ticks only the seasons the series actually has, so offering season 18 of a nine-season show
 * is harmless (`RequestWorker.ApplySeasons` never finds it) where offering too few would make a
 * season unrequestable.
 */
export const REQUEST_SEASON_FALLBACK = 20;

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
