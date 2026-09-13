import { describe, expect, test } from "bun:test";
import type { Segment } from "@/components/common/tabSegments";
import {
  DEFAULT_REQUEST_SECTION,
  kindFromRoute,
  requestsViewFromRoute,
  sectionFromRoute,
  visibleRequestSegmentKeys,
} from "./requestsSections";

/** What a member sees. */
const member: Segment[] = [
  { key: "find", label: "Discover" },
  { key: "alerts", label: "Alerts" },
];

/** What an administrator sees: the same two, plus the elevated half. */
const admin: Segment[] = [
  ...member,
  { key: "approvals", label: "Approvals" },
  { key: "activity", label: "Activity" },
  { key: "policy", label: "Policy" },
];

describe("sectionFromRoute", () => {
  test("the param wins", () => {
    expect(sectionFromRoute(member, "alerts")).toBe("alerts");
    expect(sectionFromRoute(admin, "policy")).toBe("policy");
  });

  test("a bare /requests opens on Discover", () => {
    // Where searching happens. It used to open on My requests, which put a press on a second tab in
    // front of every search.
    expect(DEFAULT_REQUEST_SECTION).toBe("find");
    expect(sectionFromRoute(member, undefined)).toBe("find");
    // `?tab=` with nothing after it is the same as no param at all.
    expect(sectionFromRoute(member, "")).toBe("find");
  });

  test("a link to the old My requests tab lands on Discover", () => {
    // Bookmarks and shared links from before the merge. The requests they meant are on Discover.
    expect(sectionFromRoute(member, "mine")).toBe("find");
    expect(sectionFromRoute(admin, "mine")).toBe("find");
  });

  test("a section this member cannot see falls back", () => {
    // A link shared by an administrator, or a demotion since the tab was
    // bookmarked. Falls to the first selectable segment rather than rendering a
    // bar with nothing selected over a blank page.
    expect(sectionFromRoute(member, "policy")).toBe("find");
    expect(sectionFromRoute(member, "nonsense")).toBe("find");
    expect(sectionFromRoute(admin, "policy")).toBe("policy");
  });
});

describe("kindFromRoute", () => {
  test("the two kinds a catalogue can be narrowed to", () => {
    // An empty Movies or TV shows library hands one of these over with
    // `tab=find`, so Find opens already showing what the reader was looking at.
    expect(kindFromRoute("movie")).toBe("movie");
    expect(kindFromRoute("series")).toBe("series");
  });

  test("anything else means nothing was asked for", () => {
    // Including `all`, which is Find's own default: the point of the param is
    // to narrow, so a param naming the default has nothing to say and must not
    // look, to `FindSection`'s guard, like an arrival that should move the bar.
    expect(kindFromRoute(undefined)).toBeUndefined();
    expect(kindFromRoute("")).toBeUndefined();
    expect(kindFromRoute("all")).toBeUndefined();
    expect(kindFromRoute("Movie")).toBeUndefined();
    expect(kindFromRoute("tvshows")).toBeUndefined();
  });
});

describe("requestsViewFromRoute", () => {
  test("?view=mine opens the whole request list", () => {
    // Written by See all on the My requests row, so a reload stays on the list.
    expect(requestsViewFromRoute("mine")).toBe("mine");
  });

  test("anything else is the catalogue", () => {
    expect(requestsViewFromRoute(undefined)).toBeUndefined();
    expect(requestsViewFromRoute("")).toBeUndefined();
    expect(requestsViewFromRoute("Mine")).toBeUndefined();
    expect(requestsViewFromRoute("all")).toBeUndefined();
  });
});

describe("visibleRequestSegmentKeys", () => {
  test("a member sees the same two sections whichever way requests are filled", () => {
    // The mode changes what an administrator does, not what anybody else sees. If this ever
    // differed, a member would be able to tell how their server is configured from the tab bar.
    expect(visibleRequestSegmentKeys(false, false)).toEqual(["find", "alerts"]);
    expect(visibleRequestSegmentKeys(false, true)).toEqual(["find", "alerts"]);
  });

  test("there is no My requests tab for anybody", () => {
    // A member's own requests are on Discover. A tab for them as well would bring back the extra
    // press this layout exists to remove.
    for (const canApprove of [false, true]) {
      for (const manual of [false, true]) {
        expect(visibleRequestSegmentKeys(canApprove, manual)).not.toContain(
          "mine" as never,
        );
      }
    }
  });

  test("an administrator on a node with an indexer keeps every section", () => {
    // Pinned so nothing above quietly takes a tab away from the setup that has always worked.
    expect(visibleRequestSegmentKeys(true, false)).toEqual([
      "find",
      "alerts",
      "approvals",
      "activity",
      "policy",
    ]);
  });

  test("with no indexer the approvals queue becomes a list and the policy goes", () => {
    // Nothing can be searched for, so there is nothing to approve and no policy governing it.
    // Activity stays: what has been transferred is a different question from how a request is
    // governed.
    expect(visibleRequestSegmentKeys(true, true)).toEqual([
      "find",
      "alerts",
      "wanted",
      "activity",
    ]);
  });
});
