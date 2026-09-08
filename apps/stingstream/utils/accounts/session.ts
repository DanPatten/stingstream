/**
 * An account token, held between signing in and choosing a server.
 *
 * **In memory, never on disk.** A token is a live session on every server it names, for twelve
 * hours, to anybody who reads it — the same reasoning that keeps a pending invite out of storage
 * (`utils/mesh/pendingInvite.ts`). What *is* persisted is the Jellyfin session the token is
 * exchanged for, which is per-server, revocable from that server, and what the app has always
 * stored.
 *
 * So this lives exactly as long as the app process, which covers the one thing it needs to: signing
 * in, then picking a server from the list that appears a render later.
 */

let token: string | null = null;

export const rememberAccountSession = (value: string | null) => {
  token = value?.trim() ? value.trim() : null;
};

/**
 * Read the token without consuming it.
 *
 * Unlike a pending invite, this one is used repeatedly — a person with three servers opens three
 * of them from the same list — so taking it on first read would break the second choice.
 */
export const takeAccountSession = (): string | null => token;

/** Forget it. Called on sign-out, and on anything that invalidates the session. */
export const forgetAccountSession = () => {
  token = null;
};
