import { describe, expect, test } from "bun:test";
import {
  MARK_SIZE,
  MASTER_LAYOUT,
  WORDMARK_SIZE,
} from "../../scripts/brand/source";
import {
  type BrandAspects,
  horizontalLayout,
  type Rect,
  stackedLayout,
  type WordmarkLockup,
} from "./wordmarkLayout";

// Pure layout math only, imported from wordmarkLayout.ts rather than
// StingStreamWordmark.tsx directly: this repo has no component render tests (see the
// other *.test.ts files, all pure logic) because `bun test` has no Flow/RN preset
// configured, and importing anything that transitively pulls in expo-image ->
// react-native fails on Flow syntax before a single assertion runs. `scripts/brand/
// source.ts` is safe to import for the same reason -- it is constants and nothing else.
//
// `constants/brandAssets.ts` is deliberately NOT imported: its module-scope requires of
// the brand PNGs are for Metro to resolve, not a test runner. The aspect ratios are taken
// from source.ts, which is where they come from in the first place. (Writing that require
// out in full here would also trip the asset scan in assets/bundled-assets.test.ts, which
// greps these directories for the literal call.)

const ASPECTS: BrandAspects = {
  mark: MARK_SIZE.width / MARK_SIZE.height,
  wordmark: WORDMARK_SIZE.width / WORDMARK_SIZE.height,
};

function assertSaneBox(box: { width: number; height: number }) {
  expect(Number.isFinite(box.width)).toBe(true);
  expect(Number.isFinite(box.height)).toBe(true);
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
}

function assertSaneRect(rect: Rect) {
  for (const n of [rect.x, rect.y, rect.width, rect.height]) {
    expect(Number.isFinite(n)).toBe(true);
  }
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
}

function assertSaneLockup(lockup: WordmarkLockup) {
  assertSaneBox(lockup);
  assertSaneRect(lockup.mark);
  assertSaneRect(lockup.wordmark);
}

describe("StingStreamWordmark layout math", () => {
  test("horizontalLayout produces a wide (landscape) box", () => {
    const layout = horizontalLayout(ASPECTS);
    assertSaneLockup(layout);
    expect(layout.width).toBeGreaterThan(layout.height);
  });

  test("stackedLayout produces a much more square box than horizontalLayout's", () => {
    const stacked = stackedLayout(ASPECTS);
    assertSaneLockup(stacked);
    expect(stacked.width / stacked.height).toBeLessThan(
      horizontalLayout(ASPECTS).width / horizontalLayout(ASPECTS).height,
    );
  });

  // Both halves are drawn with contentFit="fill" (and resized with fit:"fill" offline),
  // because every rect is supposed to be built at its own image's aspect ratio. A rect
  // that drifts from it does not fail anything -- it silently stretches the artwork.
  test("every placed rect keeps its source image's aspect ratio", () => {
    for (const lockup of [horizontalLayout(ASPECTS), stackedLayout(ASPECTS)]) {
      expect(lockup.mark.width / lockup.mark.height).toBeCloseTo(
        ASPECTS.mark,
        10,
      );
      expect(lockup.wordmark.width / lockup.wordmark.height).toBeCloseTo(
        ASPECTS.wordmark,
        10,
      );
    }
  });

  // The stacked lockup is not a composition of our own: it reproduces the delivered
  // master render, so that the generated asset IS the artwork. These four ratios are
  // the whole of that claim -- if one drifts, the lockup has quietly become something
  // the designer never drew.
  test("stackedLayout reproduces the master render's composition", () => {
    const stacked = stackedLayout(ASPECTS);
    const { mark, wordmark } = MASTER_LAYOUT;
    const masterWidth = wordmark.width;
    const masterHeight = wordmark.y + wordmark.height - mark.y;
    const norm = (value: number) => value / stacked.width;

    expect(norm(stacked.height)).toBeCloseTo(masterHeight / masterWidth, 6);
    expect(norm(stacked.mark.x)).toBeCloseTo(
      (mark.x - wordmark.x) / masterWidth,
      6,
    );
    expect(norm(stacked.mark.width)).toBeCloseTo(mark.width / masterWidth, 6);
    expect(norm(stacked.wordmark.y)).toBeCloseTo(
      (wordmark.y - mark.y) / masterWidth,
      6,
    );
  });

  test("both layouts are deterministic (no hidden randomness/time dependency)", () => {
    expect(horizontalLayout(ASPECTS)).toEqual(horizontalLayout(ASPECTS));
    expect(stackedLayout(ASPECTS)).toEqual(stackedLayout(ASPECTS));
  });
});
