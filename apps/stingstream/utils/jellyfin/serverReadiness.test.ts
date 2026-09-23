import { describe, expect, test } from "bun:test";
import {
  SERVER_QUIET_POLL_MS,
  SERVER_STARTING_BUDGET_MS,
  SERVER_STARTING_FIRST_DELAY_MS,
  SERVER_STARTING_MAX_DELAY_MS,
  SERVER_UNREACHABLE_GRACE_MS,
} from "@/constants/ServerStartup";
import {
  decideServerState,
  isStartingResponse,
  NODE_STATE_HEADER,
  nextPollDelay,
  readProbeResponse,
  type ServerWait,
} from "./serverReadiness";

const JELLYFIN = { ProductName: "Jellyfin Server", Version: "10.11.0" };

describe("isStartingResponse", () => {
  test("the gateway's own marker says starting, whatever the status", () => {
    expect(isStartingResponse(503, "starting")).toBe(true);
    expect(isStartingResponse(503, "failed")).toBe(true);
  });

  test("502, 503 and 504 mean there but not ready, from the node or a proxy in front of it", () => {
    for (const status of [502, 503, 504]) {
      expect(isStartingResponse(status, null)).toBe(true);
    }
  });

  test("other statuses are not a start-up", () => {
    for (const status of [200, 401, 403, 404, 500]) {
      expect(isStartingResponse(status, null)).toBe(false);
    }
  });
});

describe("readProbeResponse", () => {
  test("a Jellyfin document is ready", () => {
    expect(readProbeResponse({ status: 200, body: JELLYFIN })).toBe("ok");
  });

  // The bug: a node that answered 503 "starting" was reported as "Server unreachable".
  test("the gateway's 503 while the media server comes up is starting, not unreachable", () => {
    expect(
      readProbeResponse({
        status: 503,
        stateHeader: "starting",
        body: { status: "starting" },
      }),
    ).toBe("starting");
  });

  test("an older gateway's bare 503 and its 502 are starting too", () => {
    expect(
      readProbeResponse({ status: 503, body: "jellyfin is Stopped" }),
    ).toBe("starting");
    expect(readProbeResponse({ status: 502 })).toBe("starting");
  });

  test("a supervisor that gave up says failed", () => {
    expect(readProbeResponse({ status: 503, stateHeader: "failed" })).toBe(
      "failed",
    );
  });

  test("nothing answering is a miss", () => {
    expect(readProbeResponse({ networkError: true })).toBe("miss");
  });

  test("an answer that is not Jellyfin, or a plain error, is an error", () => {
    expect(readProbeResponse({ status: 200, body: "<html>" })).toBe("error");
    expect(readProbeResponse({ status: 200, body: { ProductName: "x" } })).toBe(
      "error",
    );
    expect(readProbeResponse({ status: 404 })).toBe("error");
  });
});

describe("decideServerState", () => {
  const since = 1_000_000;
  const wait = (over: Partial<ServerWait> = {}): ServerWait => ({
    since,
    answered: false,
    graceful: true,
    ...over,
  });

  test("ok is ok, whatever came before", () => {
    expect(
      decideServerState("ok", wait({ answered: true }), since + 500_000),
    ).toBe("ok");
  });

  test("starting shows starting for the whole budget, then stalls", () => {
    expect(decideServerState("starting", wait(), since)).toBe("starting");
    expect(
      decideServerState(
        "starting",
        wait(),
        since + SERVER_STARTING_BUDGET_MS - 1,
      ),
    ).toBe("starting");
    expect(
      decideServerState("starting", wait(), since + SERVER_STARTING_BUDGET_MS),
    ).toBe("stalled");
  });

  test("a supervisor that gave up stalls at once: waiting will not fix it", () => {
    expect(decideServerState("failed", wait(), since)).toBe("stalled");
  });

  test("nothing answering on a page the node just served is starting for the grace period", () => {
    expect(decideServerState("miss", wait(), since)).toBe("starting");
    expect(
      decideServerState("miss", wait(), since + SERVER_UNREACHABLE_GRACE_MS),
    ).toBe("unreachable");
  });

  test("without grace, nothing answering is unreachable at once", () => {
    expect(decideServerState("miss", wait({ graceful: false }), since)).toBe(
      "unreachable",
    );
  });

  test("a node that said starting and then went quiet is restarting, not gone", () => {
    const answered = wait({ answered: true, graceful: false });
    expect(decideServerState("miss", answered, since + 30_000)).toBe(
      "starting",
    );
    expect(
      decideServerState("miss", answered, since + SERVER_STARTING_BUDGET_MS),
    ).toBe("stalled");
  });

  test("an answer that is not Jellyfin reads as unreachable once any grace is spent", () => {
    expect(decideServerState("error", wait({ graceful: false }), since)).toBe(
      "unreachable",
    );
  });
});

describe("nextPollDelay", () => {
  test("starting backs off from the first delay to the cap", () => {
    expect(nextPollDelay("starting", 0)).toBe(SERVER_STARTING_FIRST_DELAY_MS);
    expect(nextPollDelay("starting", 1)).toBe(
      SERVER_STARTING_FIRST_DELAY_MS * 2,
    );
    expect(nextPollDelay("starting", 20)).toBe(SERVER_STARTING_MAX_DELAY_MS);
  });

  test("stalled and unreachable keep asking, quietly, so the screen still moves on by itself", () => {
    expect(nextPollDelay("stalled", 0)).toBe(SERVER_QUIET_POLL_MS);
    expect(nextPollDelay("unreachable", 3)).toBe(SERVER_QUIET_POLL_MS);
  });

  test("ok and checking do not poll", () => {
    expect(nextPollDelay("ok", 0)).toBeNull();
    expect(nextPollDelay("checking", 0)).toBeNull();
  });
});

test("the header name matches the gateway's NODE_STATE_HEADER", () => {
  expect(NODE_STATE_HEADER).toBe("x-stingstream-state");
});
