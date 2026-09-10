import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import sharp from "sharp";

/**
 * The light-ground wordmark is readable on a light ground.
 *
 * `wordmark-light.png` exists because "Sting" is rendered near-white and
 * vanishes on a white page. For a long time that was the only half treated:
 * "Stream" carried the artwork's cyan-to-violet gradient across untouched,
 * because it is the brand. On white it measured **3.22:1 on average and 1.11:1
 * at its palest** — Dan, looking at the sidebar on the light theme: *"can you
 * make the logo readable?"*.
 *
 * `scripts/brand/generate.ts` now caps its HSL lightness (`WORDMARK_LIGHT_CHROMA`
 * in `scripts/brand/source.ts`), keeping hue and saturation so it is still
 * recognisably the same gradient, just made of ink rather than of light.
 *
 * This pins the outcome rather than the constant, because the thing that can
 * quietly regress is the *art*: re-render the source paler and a cap that was
 * generous becomes insufficient, with nothing to say so. A wordmark is large
 * text, so 3:1 is the bar (WCAG 1.4.3); the mean is held far above it because a
 * logo sitting exactly on the minimum is a logo nobody can read comfortably.
 */

const WHITE_LUMINANCE = 1.0;
const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (r: number, g: number, b: number) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrastOnWhite = (r: number, g: number, b: number) =>
  (WHITE_LUMINANCE + 0.05) / (luminance(r, g, b) + 0.05);

/**
 * Only the right-hand half is measured. "Sting" is a flat dark ink and would
 * drag the average up; "Stream" is the gradient, and the gradient is the part
 * that was unreadable.
 */
const STREAM_STARTS_AT = 0.45;
/** Ignore the anti-aliased rim, which is a blend with the page behind it. */
const OPAQUE = 200;

const readStream = async (file: string) => {
  const { data, info } = await sharp(join(__dirname, file))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const ratios: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = Math.floor(width * STREAM_STARTS_AT); x < width; x++) {
      const i = (y * width + x) * channels;
      if (data[i + 3] < OPAQUE) continue;
      ratios.push(contrastOnWhite(data[i], data[i + 1], data[i + 2]));
    }
  }
  return ratios;
};

describe("the light wordmark", () => {
  test("every pixel of Stream clears the large-text bar on white", async () => {
    const ratios = await readStream("wordmark-light.png");
    expect(ratios.length).toBeGreaterThan(5000);
    const failing = ratios.filter((r) => r < 3).length;
    expect({ pixelsBelow3to1: failing }).toEqual({ pixelsBelow3to1: 0 });
  });

  test("and does so with room to spare, not by a hair", async () => {
    const ratios = await readStream("wordmark-light.png");
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    expect(mean).toBeGreaterThanOrEqual(8);
  });

  test("the dark wordmark is left alone", async () => {
    // It is drawn on bg0, where the pale gradient is exactly right. If this ever
    // starts passing the white-background check, the two variants have been
    // confused for each other.
    const ratios = await readStream("wordmark.png");
    expect(ratios.some((r) => r < 3)).toBe(true);
  });
});
