/**
 * Casting policy for the browser build.
 *
 * Android and iOS link Google's sender SDK natively. A browser loads the Cast
 * Web Sender from Google instead, on first use, which is what these two values
 * are about (`lib/cast/webCastSession.ts`).
 */

/** The Cast Web Sender, with the `cast.framework` layer the session store is written against. */
export const CAST_SDK_URL =
  "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

/**
 * How long to wait for the sender to say whether casting is available.
 *
 * A browser with no cast support still answers, and quickly, so this only ever
 * fires when the script itself never arrives: offline, or blocked by an
 * extension. Past it the button reports casting as unavailable rather than
 * leaving a press waiting on a script that is not coming.
 */
export const CAST_SDK_LOAD_TIMEOUT_MS = 10_000;
