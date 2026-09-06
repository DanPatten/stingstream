import {
  MARK_INK_BOUNDS,
  WORDMARK_TEXT_HEIGHT,
  WORDMARK_TEXT_TOP,
  WORDMARK_TEXT_WIDTH,
} from "@/constants/brand/paths";

// Pure layout math, deliberately kept free of any react-native-svg (or other
// react-native) import: this repo's `bun test` has no Flow/RN preset configured (every
// other *.test.ts in the tree is pure logic), so a test importing anything that
// transitively pulls in `react-native` fails on its Flow syntax before a single
// assertion runs. `StingStreamWordmark.tsx` imports this module and renders it;
// `StingStreamWordmark.test.ts` imports it directly and never touches react-native-svg.

const INK_W = MARK_INK_BOUNDS.maxX - MARK_INK_BOUNDS.minX;
const INK_H = MARK_INK_BOUNDS.maxY - MARK_INK_BOUNDS.minY;
const INK_CX = (MARK_INK_BOUNDS.minX + MARK_INK_BOUNDS.maxX) / 2;
const INK_CY = (MARK_INK_BOUNDS.minY + MARK_INK_BOUNDS.maxY) / 2;

/** translate(x,y) scale(s) placing MARK_INK_BOUNDS centred in a `size`x`size` square at (x,y). */
function markTransform(x: number, y: number, size: number): string {
  const scale = size / Math.max(INK_W, INK_H);
  return `translate(${x + size / 2 - INK_CX * scale} ${y + size / 2 - INK_CY * scale}) scale(${scale})`;
}

export type WordmarkLockup = {
  width: number;
  height: number;
  markTransform: string;
  textTransform: string;
};

// Same layout constants and math as `scripts/brand/generate.ts`'s `horizontalLockup` /
// `stackedLockup` -- kept in sync by hand since this file renders live with
// react-native-svg while the generator rasterises offline with sharp. Computed once
// against a reference size of 1000 units; the resulting aspect ratio is then applied to
// whatever `height` the caller passes.
const REFERENCE = 1000;

export function horizontalLayout(): WordmarkLockup {
  const margin = REFERENCE * 0.14;
  const markScale = REFERENCE / INK_H;
  const markW = INK_W * markScale;
  const gap = REFERENCE * 0.3;
  const textScale = (REFERENCE * 0.62) / WORDMARK_TEXT_HEIGHT;
  const textX = margin + markW + gap;
  const markCenterY = margin + REFERENCE / 2;
  const baselineY =
    markCenterY - textScale * (WORDMARK_TEXT_TOP + WORDMARK_TEXT_HEIGHT / 2);
  const width = margin + markW + gap + textScale * WORDMARK_TEXT_WIDTH + margin;
  const height = REFERENCE + margin * 2;
  return {
    width,
    height,
    markTransform: markTransform(margin, margin, REFERENCE),
    textTransform: `translate(${textX} ${baselineY}) scale(${textScale})`,
  };
}

export function stackedLayout(): WordmarkLockup {
  const width = REFERENCE;
  const margin = width * 0.08;
  const contentW = width - margin * 2;
  const markW = contentW * 0.34;
  const markScale = markW / INK_W;
  const markH = INK_H * markScale;
  const gap = markH * 0.32;
  const textScale = contentW / WORDMARK_TEXT_WIDTH;
  // The text's local baseline is y=0; its top sits at WORDMARK_TEXT_TOP (negative). To
  // place the top of the text block at (margin + markH + gap), the baseline must sit
  // `-textScale * WORDMARK_TEXT_TOP` further down.
  const baselineY = margin + markH + gap - textScale * WORDMARK_TEXT_TOP;
  const height =
    margin + markH + gap + textScale * WORDMARK_TEXT_HEIGHT + margin;
  return {
    width,
    height,
    markTransform: markTransform(
      margin + (contentW - markW) / 2,
      margin,
      markH,
    ),
    textTransform: `translate(${margin} ${baselineY}) scale(${textScale})`,
  };
}
