/**
 * `/sharing` — the URL for Sharing.
 *
 * The screen lives at `(home)/settings/groups/page`, which is where the
 * settings list pushes it from, but "sharing" is what the app calls it and what
 * pass-02 F-20 asks to be typeable. Rendering it here rather than redirecting
 * keeps the address stable on refresh.
 */
export { default } from "./settings/groups/page";
