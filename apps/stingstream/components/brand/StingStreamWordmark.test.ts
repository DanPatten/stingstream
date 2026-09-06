import { describe, expect, test } from "bun:test";
import { horizontalLayout, stackedLayout } from "./wordmarkLayout";

// Pure layout math only, imported from wordmarkLayout.ts rather than
// StingStreamWordmark.tsx directly: this repo has no component render tests (see the
// other 49 *.test.ts files, all pure logic) because `bun test` has no Flow/RN preset
// configured, and importing anything that transitively pulls in react-native-svg ->
// react-native fails on Flow syntax before a single assertion runs. These guard against
// the by-hand duplication of scripts/brand/generate.ts's own lockup math drifting into
// NaN or a degenerate (zero/negative) box, which would silently render nothing.

function assertSaneBox(box: { width: number; height: number }) {
  expect(Number.isFinite(box.width)).toBe(true);
  expect(Number.isFinite(box.height)).toBe(true);
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
}

function assertSaneTransform(transform: string) {
  // Every number embedded in the transform string must be finite -- a NaN here
  // silently collapses the whole <g> to nothing rather than throwing.
  const numbers = transform.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  expect(numbers.length).toBeGreaterThan(0);
  for (const n of numbers) {
    expect(Number.isFinite(Number(n))).toBe(true);
  }
}

describe("StingStreamWordmark layout math", () => {
  test("horizontalLayout produces a wide (landscape) box", () => {
    const layout = horizontalLayout();
    assertSaneBox(layout);
    assertSaneTransform(layout.markTransform);
    assertSaneTransform(layout.textTransform);
    expect(layout.width).toBeGreaterThan(layout.height);
  });

  test("stackedLayout produces a much more square box than horizontalLayout's", () => {
    const stacked = stackedLayout();
    assertSaneBox(stacked);
    assertSaneTransform(stacked.markTransform);
    assertSaneTransform(stacked.textTransform);
    const horizontal = horizontalLayout();
    const stackedAspect = stacked.width / stacked.height;
    const horizontalAspect = horizontal.width / horizontal.height;
    expect(stackedAspect).toBeLessThan(horizontalAspect);
  });

  test("both layouts are deterministic (no hidden randomness/time dependency)", () => {
    expect(horizontalLayout()).toEqual(horizontalLayout());
    expect(stackedLayout()).toEqual(stackedLayout());
  });
});
