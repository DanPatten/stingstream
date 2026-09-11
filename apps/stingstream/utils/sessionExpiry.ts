/**
 * Telling the app its session is over, from code that cannot see the app.
 *
 * The session-expiry teardown lives in `JellyfinProvider` as an axios response interceptor, which
 * covers every Jellyfin call and **nothing else**. The node's own API is reached three other ways:
 * the hand-rolled `lib/stingstream/*Api.ts` clients (raw `fetch`), the generated
 * `@stingstream/api-client` (`openapi-fetch`, funnelled through `unwrap`), and a handful of
 * modules that read a status and return `null`. None of them touches axios, so a revoked token
 * used to leave those screens failing forever against a token the app still believed in, while
 * Jellyfin's own screens logged out cleanly. That asymmetry is what this file removes.
 *
 * It imports nothing on purpose. The `*Api.ts` files are deliberately split from their hook files
 * so `bun:test` can load them without reaching `providers/JellyfinProvider` and, through it,
 * `codegenNativeComponent`, which cannot load in a test process. Anything imported here would be
 * imported by all of them, so the dependency-free shape is load-bearing rather than tidy. It also
 * rules out the obvious shortcut of writing `userAtom` directly: that would flip the redirect while
 * leaving the dead token in storage and the query cache warm, so the next launch would re-hydrate
 * straight back into the broken state. Only the provider's own teardown is the whole job.
 *
 * Modelled on `utils/appDialog.ts` (a module-level store a non-React caller drives) and
 * `utils/onAppForeground.ts` (the callback resolved at fire time, not at registration time).
 */

/**
 * A session that is over, as opposed to a request that was refused.
 *
 * 401 and 403 are not two spellings of the same thing, and collapsing them is what put "this needs
 * an administrator account on your server" in front of somebody whose token had simply been
 * revoked. 401 means the server does not know who is asking, and the answer is to sign in again.
 * 403 means it knows exactly who is asking and is saying no, which no amount of signing in fixes.
 */
export class SessionExpiredError extends Error {
  readonly expired = true;

  constructor(message: string) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

let latestHandler: (() => (() => void) | undefined) | null = null;

/**
 * Register the handler that ends a session.
 *
 * @param latest Called at the moment a 401 arrives to obtain the handler to run, so the caller can
 *   hand over something that points wherever it currently points rather than freezing the first
 *   render's closure. `JellyfinProvider`'s `handleSessionExpired` closes over `clearSessionState`,
 *   which closes over the query client and the plugin-settings setter, so a handler captured once
 *   by value would tear down the previous account's state after a switch.
 * @returns The unsubscribe function, for an effect cleanup.
 */
export const onSessionExpired = (
  latest: () => (() => void) | undefined,
): (() => void) => {
  latestHandler = latest;

  return () => {
    // Only retract our own registration. A later `onSessionExpired` replacing this one means the
    // provider re-ran its effect, and clearing it here would leave the app with no handler at all.
    if (latestHandler === latest) latestHandler = null;
  };
};

/**
 * Report that the node refused a request because it does not recognise the caller.
 *
 * A no-op when nothing is registered, and that is the normal state rather than an error: the
 * provider only registers while there is an authenticated api, which is the same guard the axios
 * interceptor uses to keep a wrong-password 401 on the login screen from counting as an expiry. A
 * 401 that arrives with no session behind it has no session to end.
 */
export const reportSessionExpired = (): void => {
  latestHandler?.()?.();
};
