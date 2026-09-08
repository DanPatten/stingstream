/**
 * An invite that arrived by link, held between the `/join` route and the Join screen.
 *
 * `/join` cannot do the joining itself: joining is an administrator action on the home node, the
 * screen for it lives deep in Settings, and a link may well be opened by a browser with no session
 * at all. So the route's whole job is to catch the code out of the address before anything
 * navigates, and put it here.
 *
 * **In memory, deliberately.** An invite carries the group secret — it is the whole credential, and
 * `InviteCard` says so on screen — so writing one to device storage would leave a key to the group
 * sitting in MMKV for as long as nobody thought to clear it. Holding it in a module variable means
 * it lives exactly as long as the app process, which covers the case that matters: a signed-in
 * person opening a link and being taken to the Join screen a navigation later. Someone signed *out*
 * is sent to sign in first and the code does not survive a reload of the page, which is the right
 * trade — they still have the link, and opening it again is one tap.
 */

let pending: string | null = null;

/** Remember a code from a link. Called during render, before anything can navigate away. */
export const rememberPendingInvite = (code: string | null) => {
  if (code?.trim()) pending = code.trim();
};

/**
 * Take the remembered code, if there is one, and forget it.
 *
 * Taking rather than reading: an invite should be offered once. Leaving it behind would re-fill the
 * field every time somebody opened Join afterwards, including long after they had used or rejected
 * it.
 */
export const takePendingInvite = (): string | null => {
  const code = pending;
  pending = null;
  return code;
};

/** Whether one is waiting, without consuming it. For tests and for a screen that wants to say so. */
export const hasPendingInvite = () => pending !== null;
