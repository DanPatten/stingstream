/**
 * Take the credentials out of a URL before it goes anywhere a person can read.
 *
 * A Jellyfin stream URL carries the caller's own access token in the query string —
 * `…/Videos/{id}/stream?…&ApiKey=<token>&…` — because that is how Jellyfin authenticates a request
 * from a player that cannot set headers. Which is fine, right up to the moment somebody logs the
 * URL: `console.log` goes to logcat on Android, to the browser console on web, and to whatever a
 * dev build is attached to, and the token it prints is a live session token for the user's own
 * node. M8b's log sweep found three such lines on the playback path.
 *
 * Redacted rather than removed, and the parameter *name* is kept, because "the URL had an ApiKey
 * and it looked like this" is exactly what somebody debugging a playback failure needs to know.
 *
 * Everything else about the URL is left alone. This is not a general-purpose sanitiser and should
 * not become one: a redactor that quietly ate a query parameter somebody needed would cost more
 * debugging time than it saved.
 */

/**
 * Query parameters whose values are credentials.
 *
 * Compared case-insensitively, because Jellyfin is not consistent about it: `ApiKey` on a stream
 * URL, `api_key` on a WebSocket, `X-Emby-Token` in a header of the same name.
 */
const SECRET_PARAMS = new Set([
  "apikey",
  "api_key",
  "x-emby-token",
  "x-mediabrowser-token",
  "token",
  "accesstoken",
  "access_token",
]);

/** What a redacted value is replaced with. Deliberately not empty, so the parameter is still visible. */
const REDACTED = "<redacted>";

/**
 * A URL with any credential-carrying query parameter's value replaced.
 *
 * Returns the input unchanged when it is not a URL at all (a bare path, a `stingstream.local`
 * marker, an empty string), because the callers are log lines and a log line that threw would be a
 * worse bug than the one this prevents.
 *
 * @param url The URL, or anything else.
 * @returns The URL with credentials redacted.
 */
export function redactUrl(url: string | null | undefined): string {
  if (!url) return "";
  const question = url.indexOf("?");
  if (question < 0) return url;

  const base = url.slice(0, question);
  // `URLSearchParams` rather than a regular expression: a token is base64-ish and can contain
  // characters a naive `[^&]*` match handles by luck rather than by rule, and the query can carry
  // a percent-encoded `&` inside a legitimate value.
  const params = new URLSearchParams(url.slice(question + 1));
  let touched = false;
  for (const key of [...params.keys()]) {
    if (SECRET_PARAMS.has(key.toLowerCase())) {
      params.set(key, REDACTED);
      touched = true;
    }
  }
  if (!touched) return url;
  return `${base}?${params.toString()}`;
}
