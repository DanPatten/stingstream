/**
 * `/search` — the URL for Search.
 *
 * Every one of the ten tab groups holds an `index`, and a group's name is
 * invisible in the URL, so all ten of them claim `/` and only the one that wins
 * expo-router's tie-break is ever reachable by address. That is why typing
 * `/requests` used to land on the library-by-id route and spin (pass-02 F-20):
 * `(libraries)/[libraryId]` was the only route that matched. A named file
 * inside the group gives the section a path of its own, and a static segment
 * outranks a dynamic one, so `/search` now resolves here instead.
 *
 * It renders the group's own screen rather than redirecting to it, because a
 * redirect would put the address bar back on `/` and the section would be
 * unreachable on refresh, in a bookmark, or with the browser's back button.
 */
export { default } from "./index";
