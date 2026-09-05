import { describe, expect, test } from "bun:test";
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
