import { beforeAll, describe, expect, test } from "bun:test";
import i18n from "i18next";
import { isExpectedError } from "@/utils/errors";
import { onSessionExpired, SessionExpiredError } from "@/utils/sessionExpiry";
import en from "../../translations/en.json";
import { ApiError, unwrap } from "./unwrap";

const result = <T>(
  status: number,
  body: { data?: T; error?: unknown } = {},
): { data?: T; error?: unknown; response: Response } => ({
  ...body,
  response: new Response(null, { status }) as Response,
});

describe("unwrap", () => {
  test("returns the data when there is data", () => {
    expect(
      unwrap(result(200, { data: { Items: [1] } }), "GET /downloads"),
    ).toEqual({
      Items: [1],
    });
  });

  test("a bodyless 404 falls through to a sentence about the node, not a crash", () => {
    // The bug M5's signed build hit. `openapi-fetch` fills in neither `data` nor `error` when the
    // body will not parse, and a queryFn that returns undefined makes react-query throw
    // `["stingstream","downloads"] data is undefined` — which tells the person reading it nothing.
    let thrown: unknown;
    try {
      unwrap(result(404), "GET /downloads", { Items: [] });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(404);
    expect((thrown as ApiError).message).toContain("older than the app");
    expect((thrown as ApiError).message).toContain("GET /downloads");
  });

  test("a successful response with no body uses the fallback", () => {
    // A 204, or a handler that returned nothing. An empty list is the honest reading.
    expect(unwrap(result(204), "GET /downloads", { Items: [] })).toEqual({
      Items: [],
    });
    expect(unwrap(result(200), "GET /downloads", { Items: [] })).toEqual({
      Items: [],
    });
  });

  test("a bodyless success with no fallback is an error, because for most endpoints it is", () => {
    expect(() => unwrap(result(200), "GET /history")).toThrow(/no body/);
  });

  test("the server's own sentence survives, whichever field it used", () => {
    // Core answers `{ error }`; ASP.NET's ProblemDetails answers `{ title }`; the arrs' pass-through
    // answers `{ Message }`. All three are the most useful thing on the screen.
    expect(() =>
      unwrap(
        result(503, { error: { error: "the mesh is not answering" } }),
        "GET /mesh/groups",
      ),
    ).toThrow("the mesh is not answering");
    expect(() =>
      unwrap(
        result(400, { error: { title: "One or more validation errors" } }),
        "POST /x",
      ),
    ).toThrow("One or more validation errors");
    expect(() =>
      unwrap(
        result(409, { error: { Message: "QualityProfile [5] is in use." } }),
        "DELETE /x",
      ),
    ).toThrow("QualityProfile [5] is in use.");
    expect(() =>
      unwrap(result(500, { error: "plain string" }), "GET /x"),
    ).toThrow("plain string");
  });

  test("an error with nothing readable in it still names the endpoint and the status", () => {
    expect(() => unwrap(result(502, { error: {} }), "GET /downloads")).toThrow(
      "GET /downloads failed with 502.",
    );
  });

  test("a null data field is treated as missing, not as a value", () => {
    // ASP.NET serialises a null ActionResult body as the four characters `null`, which parses.
    expect(
      unwrap(result(200, { data: null as never }), "GET /downloads", {
        Items: [],
      }),
    ).toEqual({
      Items: [],
    });
  });
});

/**
 * The generated `openapi-fetch` client is the third way this app reaches the node, and it had no
 * 401 handling of its own: a revoked token came back as "answered 401 with no body", which reads
 * like a broken endpoint rather than a session that ended.
 */
describe("unwrap and an expired session", () => {
  beforeAll(async () => {
    if (!i18n.isInitialized) {
      await i18n.init({
        lng: "en",
        fallbackLng: "en",
        resources: { en: { translation: en } },
        interpolation: { escapeValue: false },
      });
    }
  });

  test("a bodyless 401 is a session that ended, not a missing endpoint", () => {
    // ASP.NET's 401 challenge carries no body, so `openapi-fetch` fills in neither `data` nor
    // `error`. Checking the status ahead of both is what catches it.
    let thrown: unknown;
    try {
      unwrap(result(401), "GET /downloads");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SessionExpiredError);
    expect((thrown as Error).message).toBe(
      "Your session has expired. Sign in again.",
    );
    expect(isExpectedError(thrown)).toBe(true);
  });

  test("a 401 ends the session", () => {
    let reports = 0;
    const stop = onSessionExpired(() => () => {
      reports += 1;
    });

    expect(() => unwrap(result(401), "GET /downloads")).toThrow();

    expect(reports).toBe(1);
    stop();
  });

  test("a 403 is left alone, because signing in again cannot fix it", () => {
    let reports = 0;
    const stop = onSessionExpired(() => () => {
      reports += 1;
    });

    let thrown: unknown;
    try {
      unwrap(
        result(403, { error: { error: "Administrators only." } }),
        "POST /requests/1/approve",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).not.toBeInstanceOf(SessionExpiredError);
    expect(reports).toBe(0);
    stop();
  });
});
