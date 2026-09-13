import { describe, expect, test } from "bun:test";
import type { Segment } from "@/components/common/tabSegments";
import {
  DEFAULT_REQUEST_SECTION,
  kindFromRoute,
  sectionFromRoute,
  visibleRequestSegmentKeys,
} from "./requestsSections";

/** What a member sees. */
const member: Segment[] = [
  { key: "find", label: "Discover" },
  { key: "mine", label: "My requests" },
  { key: "alerts", label: "Alerts" },
];

/** What an administrator sees: the same three, plus the elevated half. */
const admin: Segment[] = [
  ...member,
  { key: "approvals", label: "Approvals" },
  { key: "activity", label: "Activity" },
  { key: "policy", label: "Policy" },
];

describe("sectionFromRoute", () => {
  test("the param wins", () => {
    expect(sectionFromRoute(member, "alerts")).toBe("alerts");
    expect(sectionFromRoute(member, "mine")).toBe("mine");
    expect(sectionFromRoute(admin, "policy")).toBe("policy");
  });

  test("a bare /requests opens on Discover, not My requests", () => {
    // Where searching happens. It used to open on My requests, which put a press on a second tab in
    // front of every search. My requests is a tab again, and Discover still comes first.
    expect(DEFAULT_REQUEST_SECTION).toBe("find");
    expect(sectionFromRoute(member, undefined)).toBe("find");
    // `?tab=` with nothing after it is the same as no param at all.
    expect(sectionFromRoute(member, "")).toBe("find");
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

describe("visibleRequestSegmentKeys", () => {
  test("a member sees the same three sections whichever way requests are filled", () => {
    // The mode changes what an administrator does, not what anybody else sees. If this ever
    // differed, a member would be able to tell how their server is configured from the tab bar.
    expect(visibleRequestSegmentKeys(false, false)).toEqual([
      "find",
      "mine",
      "alerts",
    ]);
    expect(visibleRequestSegmentKeys(false, true)).toEqual([
      "find",
      "mine",
      "alerts",
    ]);
  });

  test("Discover is always the first tab", () => {
    // The tab Requests is about. My requests follows it rather than leading, whoever is looking.
    for (const canApprove of [false, true]) {
      for (const manual of [false, true]) {
        expect(visibleRequestSegmentKeys(canApprove, manual)[0]).toBe("find");
      }
    }
  });

  test("an administrator on a node with an indexer keeps every section", () => {
    // Pinned so nothing above quietly takes a tab away from the setup that has always worked.
    expect(visibleRequestSegmentKeys(true, false)).toEqual([
      "find",
      "mine",
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
      "mine",
      "alerts",
      "wanted",
      "activity",
    ]);
  });
});
