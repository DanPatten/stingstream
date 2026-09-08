// Pure layout math, deliberately kept free of any react-native (or expo-image) import:
// this repo's `bun test` has no Flow/RN preset configured (every other *.test.ts in the
// tree is pure logic), so a test importing anything that transitively pulls in
// `react-native` fails on its Flow syntax before a single assertion runs.
// `StingStreamWordmark.tsx` imports this module and renders it; `wordmarkLayout.test.ts`
// imports it directly and never touches a component.
//
// `scripts/brand/generate.ts` imports these same two functions to composite the offline
// rasters. That import is the point: the previous version of this file carried a comment
// saying its maths was "kept in sync by hand" with the generator's own copy. There is now
// one copy, so there is nothing to keep in sync. Everything is unitless -- callers scale
// the returned box to whatever size they need.

/** A placed piece of a lockup, in layout units. */
export type Rect = { x: number; y: number; width: number; height: number };

/** Intrinsic width/height ratio of each source image. */
export type BrandAspects = { mark: number; wordmark: number };

export type WordmarkLockup = {
  width: number;
  height: number;
  mark: Rect;
  wordmark: Rect;
};

/** Mark height in a horizontal lockup; everything else is expressed against it. */
const HORIZONTAL_REFERENCE = 1000;
const HORIZONTAL_MARGIN = 0.14;
const HORIZONTAL_GAP = 0.3;
/**
 * Wordmark height as a fraction of mark height in a horizontal lockup. The vector
 * wordmark this replaced used 0.62, but the rendered wordmark is proportionally wider
 * (aspect 5.67 against the old 4.80), so 0.62 made the text dominate the mark and pushed
 * the whole lockup too wide to fill a 320x180 TV banner. 0.50 restores the previous
 * overall lockup aspect (~3.1) and echoes the restraint of the delivered stacked art.
 */
const HORIZONTAL_WORDMARK_HEIGHT = 0.5;

/**
 * The stacked lockup's proportions, taken from the delivered master render so the
 * generated asset *is* the artwork rather than an approximation of it. Against a
 * wordmark width of 856px the master places a 400x674 mark with a 17px gap, its centre
 * 8px left of the wordmark's. See `scripts/brand/source.ts` for the measured boxes.
 */
const STACKED_MARK_WIDTH = 400 / 856;
const STACKED_GAP = 17 / 674;
const STACKED_MARK_CENTER_OFFSET = -8 / 856;

/** Mark beside the wordmark, wordmark vertically centred on the mark. */
export function horizontalLayout(aspects: BrandAspects): WordmarkLockup {
  const markH = HORIZONTAL_REFERENCE;
  const margin = markH * HORIZONTAL_MARGIN;
  const gap = markH * HORIZONTAL_GAP;
  const markW = markH * aspects.mark;
  const wordmarkH = markH * HORIZONTAL_WORDMARK_HEIGHT;
  const wordmarkW = wordmarkH * aspects.wordmark;
  return {
    width: margin + markW + gap + wordmarkW + margin,
    height: markH + margin * 2,
    mark: { x: margin, y: margin, width: markW, height: markH },
    wordmark: {
      x: margin + markW + gap,
      y: margin + (markH - wordmarkH) / 2,
      width: wordmarkW,
      height: wordmarkH,
    },
  };
}

/** Mark above the wordmark, reproducing the delivered composition. */
export function stackedLayout(aspects: BrandAspects): WordmarkLockup {
  const width = HORIZONTAL_REFERENCE;
  const markW = width * STACKED_MARK_WIDTH;
  const markH = markW / aspects.mark;
  const gap = markH * STACKED_GAP;
  const wordmarkH = width / aspects.wordmark;
  return {
    width,
    height: markH + gap + wordmarkH,
    mark: {
      x: (width - markW) / 2 + width * STACKED_MARK_CENTER_OFFSET,
      y: 0,
      width: markW,
      height: markH,
    },
    wordmark: { x: 0, y: markH + gap, width, height: wordmarkH },
  };
}
