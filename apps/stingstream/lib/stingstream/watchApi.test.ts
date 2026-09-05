import { describe, expect, test } from "bun:test";
import {
  DRIFT_BUDGET_MS,
  invitableSession,
  isNodeInSession,
  toWatchSession,
  toWatchSessionView,
  type WatchSession,
  worstDriftMs,
} from "./watchApi";

/**
 * The decisions the invite banner makes, and the casing it has to survive.
 *
 * Core answers PascalCase (`docs/APP-MESH.md` §6) despite every doc calling these fields by their
 * camelCase names, so every reader accepts both — and the first two tests are what stop that
 * quietly regressing to one of them.
 */
describe("watchApi", () => {
  const pascal = {
    Id: "abc123",
    ItemKey: "movie:tmdb:22820",
    Title: "Sita Sings the Blues",
    Leader: "AAAA",
    LeaderName: "attic",
    Participants: [
      {
        Node: "AAAA",
        NodeName: "attic",
        Viewers: 1,
        RttMs: 0,
        DriftMs: 0,
        Buffering: false,
        LastSeenMs: 1000,
      },
      {
        Node: "BBBB",
        NodeName: "loft",
        Viewers: 2,
        RttMs: 8,
        DriftMs: -120,
        Buffering: false,
        LastSeenMs: 1000,
      },
    ],
    State: "playing",
    PositionMs: 41_000,
    AtMs: 1_788_000_000_000,
    Seq: 7,
    Closed: false,
    UpdatedAtMs: 1_788_000_000_000,
  };

  const camel = {
    id: "abc123",
    itemKey: "movie:tmdb:22820",
    title: "Sita Sings the Blues",
    leader: "AAAA",
    leaderName: "attic",
    participants: [
      {
        node: "AAAA",
        nodeName: "attic",
        viewers: 1,
        rttMs: 0,
        driftMs: 0,
        buffering: false,
        lastSeenMs: 1000,
      },
      {
        node: "BBBB",
        nodeName: "loft",
        viewers: 2,
        rttMs: 8,
        driftMs: -120,
        buffering: false,
        lastSeenMs: 1000,
      },
    ],
    state: "playing",
    positionMs: 41_000,
    atMs: 1_788_000_000_000,
    seq: 7,
    closed: false,
    updatedAtMs: 1_788_000_000_000,
  };

  test("both casings read identically", () => {
    expect(toWatchSession(pascal)).toEqual(toWatchSession(camel));
  });

  test("a session reads back whole", () => {
    const session = toWatchSession(pascal);
    expect(session.id).toBe("abc123");
    expect(session.itemKey).toBe("movie:tmdb:22820");
    expect(session.leaderName).toBe("attic");
    expect(session.state).toBe("playing");
    expect(session.participants).toHaveLength(2);
    expect(session.participants[1].driftMs).toBe(-120);
  });

  test("a view carries where the film is right now", () => {
    const view = toWatchSessionView({
      Session: pascal,
      PositionMs: 44_500,
      NowMs: 1_788_000_003_500,
    });
    expect(view.session?.id).toBe("abc123");
    // Not the session's own PositionMs: the view's is the leader's position advanced to `NowMs`,
    // which is the number a caller comparing two nodes needs.
    expect(view.positionMs).toBe(44_500);
  });

  test("a view with no session is not a crash", () => {
    expect(toWatchSessionView({}).session).toBeNull();
  });

  // --- who is in the room --------------------------------------------------------------------

  const session = (over: Partial<WatchSession> = {}): WatchSession => ({
    ...toWatchSession(camel),
    ...over,
  });

  test("the leader's own node is in the session", () => {
    expect(isNodeInSession(session(), "AAAA")).toBe(true);
  });

  test("a participant's node is in the session", () => {
    expect(isNodeInSession(session(), "BBBB")).toBe(true);
  });

  test("anybody else is not", () => {
    expect(isNodeInSession(session(), "CCCC")).toBe(false);
    expect(isNodeInSession(session(), null)).toBe(false);
  });

  /** Node ids appear in two encodings across the codebase; comparing them case-sensitively is a
   *  bug waiting for the first person whose id starts with a letter. */
  test("node ids compare without case", () => {
    expect(isNodeInSession(session(), "aaaa")).toBe(true);
  });

  // --- which session earns a banner -----------------------------------------------------------

  test("a session this node is already in is not an invite", () => {
    expect(invitableSession([session()], "AAAA")).toBeNull();
    expect(invitableSession([session()], "BBBB")).toBeNull();
  });

  test("a session this node is not in is", () => {
    expect(invitableSession([session()], "CCCC")?.id).toBe("abc123");
  });

  test("a closed session is never an invite", () => {
    expect(invitableSession([session({ closed: true })], "CCCC")).toBeNull();
  });

  test("the newest wins, because it is the one somebody has just started", () => {
    const older = session({ id: "older", updatedAtMs: 1000 });
    const newer = session({ id: "newer", updatedAtMs: 2000 });
    expect(invitableSession([older, newer], "CCCC")?.id).toBe("newer");
    expect(invitableSession([newer, older], "CCCC")?.id).toBe("newer");
  });

  test("nothing open is nothing to show", () => {
    expect(invitableSession([], "CCCC")).toBeNull();
  });

  // --- how in step it is ------------------------------------------------------------------------

  /** A room 400 ms *behind* is exactly as out of step as one 400 ms ahead. */
  test("drift is the worst node's, unsigned", () => {
    expect(worstDriftMs(session())).toBe(120);
  });

  test("drift is null until somebody has reported", () => {
    const nobody = session({
      participants: session().participants.map((p) => ({
        ...p,
        driftMs: undefined,
      })),
    });
    expect(worstDriftMs(nobody)).toBeNull();
  });

  test("the budget is the milestone's own bar", () => {
    expect(DRIFT_BUDGET_MS).toBe(1000);
  });
});
