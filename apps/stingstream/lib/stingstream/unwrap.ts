/**
 * Turning an `openapi-fetch` result into a value a react-query `queryFn` may return.
 *
 * The reason this exists rather than `if (error) throw error; return data as T` at every call
 * site: **there is a third case, and it is the one that reaches users.** `openapi-fetch` parses the
 * response body to decide which of `data` and `error` to fill in, so a response with no parseable
 * body fills in neither — and a `queryFn` that returns `undefined` makes react-query throw
 * `["stingstream","downloads"] data is undefined`, which tells whoever sees it nothing at all.
 *
 * That is not a hypothetical. It is exactly what an app built against a newer server does when it
 * is pointed at a node that predates an endpoint: ASP.NET answers `404` with an empty body, and the
 * screen shows a crash instead of "this node is too old". M5's signed phone build hit it on the
 * Downloads tab against a node without M4.5's Core.
 *
 * So: `error` is thrown with the status attached, a missing body falls back when the caller has a
 * sensible empty value, and anything else throws a sentence that names the endpoint and the status.
 */

export interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** An error carrying the HTTP status, so a screen can tell 404 from 503. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Unwrap a result, or throw something a person can act on.
 *
 * @param result what `openapi-fetch` returned.
 * @param what the endpoint, for the message — e.g. `GET /downloads`.
 * @param fallback the value to use when the call succeeded but carried no body. Pass one only
 *   where an empty answer is genuinely meaningful; omitting it turns a bodyless 200 into an error,
 *   which for most endpoints is the truth.
 */
export function unwrap<T>(
  result: FetchResult<T>,
  what: string,
  fallback?: T,
): T {
  const status = result.response?.status ?? 0;

  if (result.error !== undefined && result.error !== null) {
    throw new ApiError(describe(result.error, what, status), status);
  }

  if (result.data === undefined || result.data === null) {
    // A 2xx with nothing in it is a real, if unusual, success — `204 No Content`, or a handler
    // that returned an empty body. Anything else is the endpoint not being there.
    if (status >= 200 && status < 300 && fallback !== undefined) {
      return fallback;
    }
    if (fallback !== undefined && status === 404) {
      throw new ApiError(
        `${what} answered 404. This node's StingStream.Core is older than the app and does not have that endpoint yet.`,
        status,
      );
    }
    throw new ApiError(
      `${what} answered ${status || "nothing"} with no body.`,
      status,
    );
  }

  return result.data;
}

/** The most useful sentence available from whatever the server put in the error body. */
function describe(error: unknown, what: string, status: number): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["error", "message", "title", "Message", "detail"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return `${what} failed with ${status || "no status"}.`;
}
