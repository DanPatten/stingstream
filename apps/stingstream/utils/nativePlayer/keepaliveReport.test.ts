import { describe, expect, test } from "bun:test";
import { sendKeepaliveReport } from "./keepaliveReport";

const api = {
  basePath: "http://127.0.0.1:5173/jellyfin",
  authorizationHeader: 'MediaBrowser Token="abc"',
};

describe("sendKeepaliveReport", () => {
  test("a stop report goes to the stopped endpoint, kept alive, with the token", () => {
    const calls: [string, RequestInit][] = [];
    sendKeepaliveReport(
      api,
      { kind: "stopped", info: { ItemId: "i1", PositionTicks: 42 } },
      async (url, init) => {
        calls.push([url, init]);
      },
    );

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe("http://127.0.0.1:5173/jellyfin/Sessions/Playing/Stopped");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      api.authorizationHeader,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      ItemId: "i1",
      PositionTicks: 42,
    });
  });

  test("a progress report goes to the progress endpoint", () => {
    let seen = "";
    sendKeepaliveReport(
      api,
      { kind: "progress", info: { ItemId: "i1", PositionTicks: 7 } },
      async (url) => {
        seen = url;
      },
    );
    expect(seen).toBe(
      "http://127.0.0.1:5173/jellyfin/Sessions/Playing/Progress",
    );
  });

  test("a refused or failing request is swallowed", async () => {
    expect(() =>
      sendKeepaliveReport(api, { kind: "progress", info: {} }, () => {
        throw new Error("quota");
      }),
    ).not.toThrow();
    expect(() =>
      sendKeepaliveReport(api, { kind: "progress", info: {} }, () =>
        Promise.reject(new Error("offline")),
      ),
    ).not.toThrow();
    // Let the rejected promise settle, so an unhandled rejection would surface here.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
