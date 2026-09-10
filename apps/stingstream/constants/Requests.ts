/**
 * Find-screen policy, shared by the two screens that draw one.
 *
 * `FindSection` is the phone and web screen on the Requests tab; `DiscoverSection` is the
 * television's, which is a separate screen with a remote control to type on. They ask the node the
 * same questions and so have to agree about when to ask them — see `docs/conventions/constants.md`.
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
 * `RequestSearchResult.seasonCount` carries the real number when the answer it came from had one.
 * A search does: the season list is on the lookup entry. A show reached from the catalogue does
 * not, because a browse response carries no season count and asking for one would be a second call
 * per poster on the screen. Generous on purpose: the
 * node ticks only the seasons the series actually has, so offering season 18 of a nine-season show
 * is harmless (`RequestWorker.ApplySeasons` never finds it) where offering too few would make a
 * season unrequestable.
 */
export const REQUEST_SEASON_FALLBACK = 20;

/**
 * The earliest year the year chip offers.
 *
 * Far enough back to cover everything the catalogue holds. The chip's sheet grows its own search
 * box past fifteen options, so a long list costs a reader nothing.
 */
export const REQUEST_YEAR_FLOOR = 1900;
