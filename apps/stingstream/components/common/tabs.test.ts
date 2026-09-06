import { describe, expect, test } from "bun:test";
import {
  resolveSegment,
  type Segment,
  shouldChangeSegment,
  tabsLayoutFor,
} from "./tabSegments";

const segments: Segment[] = [
  { key: "movies", label: "Movies" },
  { key: "series", label: "Series" },
  { key: "calendar", label: "Calendar" },
];

describe("tabsLayoutFor", () => {
  test("pills on a phone, underline from a tablet up", () => {
    expect(tabsLayoutFor("compact")).toBe("pills");
    expect(tabsLayoutFor("medium")).toBe("underline");
    expect(tabsLayoutFor("expanded")).toBe("underline");
  });
});

describe("resolveSegment", () => {
  test("keeps a valid selection", () => {
    expect(resolveSegment(segments, "series")).toBe("series");
  });

  test("falls back to the first segment when the value is unknown", () => {
    // The case this exists for: a section that used to be there (an admin-only
    // tab after a demotion, a key from a deep link, a persisted choice from an
    // older build). Rendering no selection at all leaves the screen showing
    // content that matches nothing highlighted.
    expect(resolveSegment(segments, "approvals")).toBe("movies");
    expect(resolveSegment(segments, undefined)).toBe("movies");
  });

  test("skips disabled segments when falling back", () => {
    const withDisabled: Segment[] = [
      { key: "movies", label: "Movies", disabled: true },
      { key: "series", label: "Series" },
    ];
    expect(resolveSegment(withDisabled, "gone")).toBe("series");
  });

  test("a disabled segment is never selected, even by name", () => {
    const withDisabled: Segment[] = [
      { key: "movies", label: "Movies" },
      { key: "series", label: "Series", disabled: true },
    ];
    expect(resolveSegment(withDisabled, "series")).toBe("movies");
  });

  test("undefined when nothing is selectable", () => {
    expect(resolveSegment([], "movies")).toBeUndefined();
    expect(
      resolveSegment([{ key: "a", label: "A", disabled: true }], "a"),
    ).toBeUndefined();
  });
});

describe("shouldChangeSegment", () => {
  test("a different, enabled segment changes", () => {
    expect(shouldChangeSegment(segments, "movies", "series")).toBe(true);
  });

  test("re-pressing the selected segment does not", () => {
    // Screens refetch, scroll to top or reset a filter on change; a stray tap
    // on the current tab should not do any of that.
    expect(shouldChangeSegment(segments, "movies", "movies")).toBe(false);
  });

  test("re-pressing the *effective* selection does not, either", () => {
    // `value` is stale, so the bar is really showing "movies" — pressing it
    // must be the same no-op as pressing the tab that looks selected.
    expect(shouldChangeSegment(segments, "approvals", "movies")).toBe(false);
  });

  test("a disabled or unknown segment never changes", () => {
    const withDisabled: Segment[] = [
      { key: "movies", label: "Movies" },
      { key: "series", label: "Series", disabled: true },
    ];
    expect(shouldChangeSegment(withDisabled, "movies", "series")).toBe(false);
    expect(shouldChangeSegment(segments, "movies", "nope")).toBe(false);
  });
});
