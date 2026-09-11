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
  { key: "find", label: "Find" },
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
    expect(sectionFromRoute(admin, "policy")).toBe("policy");
  });

  test("a bare /requests opens on the default", () => {
    expect(sectionFromRoute(member, undefined)).toBe(DEFAULT_REQUEST_SECTION);
    // `?tab=` with nothing after it is the same as no param at all.
    expect(sectionFromRoute(member, "")).toBe(DEFAULT_REQUEST_SECTION);
  });

  test("a term with no section lands on Find", () => {
    // Search's `Request "…"` button sends both; anything that sends only `?q=`
    // still means "ask for this", and Find is the only section that can.
    expect(sectionFromRoute(member, undefined, "Nosferatu")).toBe("find");
    expect(sectionFromRoute(member, undefined, "   ")).toBe(
      DEFAULT_REQUEST_SECTION,
    );
  });

  test("the param beats the term, so pressing a tab sticks", () => {
    // The old behaviour was an effect that forced Find whenever `q` was set,
    // which meant a member who arrived from Search and then pressed My requests
    // could be thrown back on the next render.
    expect(sectionFromRoute(member, "mine", "Nosferatu")).toBe("mine");
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
