import { describe, expect, test } from "bun:test";
import { READY_REQUEST_WINDOW_MS } from "@/constants/Home";
import type { MemberRequest } from "@/lib/stingstream/requestsApi";
import { hasStartedWatching, recentReadyRequests } from "./readyRequests";

const now = Date.parse("2026-09-28T12:00:00Z");
const request = (overrides: Partial<MemberRequest> = {}): MemberRequest => ({
  id: "request",
  group: "group",
  kind: "movie",
  itemKey: "tmdb:1",
  provider: "tmdb",
  providerId: 1,
  title: "Movie",
  seasons: [],
  state: "available",
  requestedBy: "user",
  requestedByName: "User",
  requestedAt: "2026-01-01T00:00:00Z",
  note: "",
  mine: true,
  localItemId: "movie",
  updatedAt: new Date(now - 1000).toISOString(),
  ...overrides,
});
describe("ready requests", () => {
  test("counts three days from availability, not the original request", () => {
    expect(recentReadyRequests([request()], now)).toHaveLength(1);
    expect(
      recentReadyRequests(
        [
          request({
            updatedAt: new Date(now - READY_REQUEST_WINDOW_MS).toISOString(),
          }),
        ],
        now,
      ),
    ).toEqual([]);
  });
  test("requires availability, a local item, and a valid nonfuture date", () => {
    for (const overrides of [
      { state: "wanted" as const },
      { localItemId: null },
      { updatedAt: "invalid" },
      { updatedAt: new Date(now + 1).toISOString() },
    ]) {
      expect(recentReadyRequests([request(overrides)], now)).toEqual([]);
    }
  });
  test("newest arrivals first", () => {
    expect(
      recentReadyRequests(
        [
          request({
            id: "older",
            updatedAt: new Date(now - 2000).toISOString(),
          }),
          request({ id: "newer" }),
        ],
        now,
      ).map((r) => r.id),
    ).toEqual(["newer", "older"]);
  });
  test("even minimal progress or a previous start excludes a movie or episode", () => {
    expect(hasStartedWatching({ PlaybackPositionTicks: 1 })).toBe(true);
    expect(hasStartedWatching({ PlayCount: 1 })).toBe(true);
    expect(hasStartedWatching({ LastPlayedDate: "2026-09-28T00:00:00Z" })).toBe(
      true,
    );
    expect(hasStartedWatching({ Played: true })).toBe(true);
    expect(
      hasStartedWatching({
        PlaybackPositionTicks: 0,
        PlayCount: 0,
        Played: false,
      }),
    ).toBe(false);
    expect(hasStartedWatching()).toBe(false);
  });
});
