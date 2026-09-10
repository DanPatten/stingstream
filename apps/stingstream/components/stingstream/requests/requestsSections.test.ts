import { describe, expect, test } from "bun:test";
import type { Segment } from "@/components/common/tabSegments";
import { DEFAULT_REQUEST_SECTION, sectionFromRoute } from "./requestsSections";

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
