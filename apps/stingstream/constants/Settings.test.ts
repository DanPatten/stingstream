import { describe, expect, test } from "bun:test";
import {
  SETTINGS_NAV_WIDTH,
  SETTINGS_TWO_PANE_MIN_WIDTH,
  settingsTwoPane,
} from "./Settings";
import { breakpoints, maxWidth } from "./theme";

// `useBreakpoint` reads a module-scope `Dimensions` listener that a plain
// `bun test` spec has no way to drive, so the rule lives here as a pure
// function and the component only asks it the question.

describe("settingsTwoPane", () => {
  test("two panes from 1024 up, on web", () => {
    expect(settingsTwoPane(SETTINGS_TWO_PANE_MIN_WIDTH, true)).toBe(true);
    expect(settingsTwoPane(1440, true)).toBe(true);
    expect(settingsTwoPane(2560, true)).toBe(true);
  });

  test("one pane below it, even on web", () => {
    // The app's own desktop floor is 768, and this deliberately is not it: at
    // that width the 240 px application sidebar and a 264 px category column
    // leave less than a third of the window for the page.
    expect(settingsTwoPane(SETTINGS_TWO_PANE_MIN_WIDTH - 1, true)).toBe(false);
    expect(settingsTwoPane(breakpoints.medium, true)).toBe(false);
    expect(settingsTwoPane(390, true)).toBe(false);
  });

  test("never off the web, however wide", () => {
    // A tablet and a television are both wide and get neither the sidebar nor
    // this column — the same rule `isWebWide` already encodes.
    expect(settingsTwoPane(1440, false)).toBe(false);
    expect(settingsTwoPane(2560, false)).toBe(false);
  });

  test("the threshold really does fit all three columns", () => {
    // 240 sidebar + 264 category column + a page that can still reach its own
    // comfortable measure. If any of the three grows, this fails rather than
    // quietly producing a 200 px form.
    const SIDEBAR = 240;
    const page = SETTINGS_TWO_PANE_MIN_WIDTH - SIDEBAR - SETTINGS_NAV_WIDTH;
    expect(page).toBeGreaterThanOrEqual(maxWidth.prose * 0.6);
  });
});
