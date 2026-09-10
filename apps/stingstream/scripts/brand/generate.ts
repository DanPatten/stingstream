#!/usr/bin/env bun
/**
 * StingStream brand asset generator.
 *
 * Reads the authored source art (`source.ts` -- two PNGs cut once from the delivered
 * master render, never regenerated from a design tool at build time) and rasterises every
 * icon, favicon, TV asset and store-listing image the app and its docs reference, plus the
 * lockups. Also (re)writes `constants/brandAssets.ts`, the committed app-importable handle
 * on the same art that `components/brand/*` renders, and `mark.png.base64` for the Rust
 * gateway's first-paint splash.
 *
 * Run once and commit the outputs:
 *   bun scripts/brand/generate.ts
 *
 * The lockup geometry is imported from `components/brand/wordmarkLayout.ts` rather than
 * duplicated here: the app renders live from those same functions, and the previous
 * arrangement -- two copies of the maths "kept in sync by hand" -- is exactly the drift
 * this avoids.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";
import {
  type BrandAspects,
  horizontalLayout,
  stackedLayout,
  type WordmarkLockup,
} from "../../components/brand/wordmarkLayout";
import {
  BRAND_ACCENT,
  BRAND_BG,
  MARK_SIZE,
  MONO_ALPHA_LEVELS,
  SOURCE_FILES,
  WORDMARK_LIGHT_CHROMA,
  WORDMARK_LIGHT_INK,
  WORDMARK_SATURATION,
  WORDMARK_SIZE,
} from "./source";

const APP_ROOT = join(__dirname, "..", "..");
// docs/screenshots/ is a top-level, monorepo-wide directory (docs/APP-RELEASE.md,
// deploy/play/checklist.md and its own README.md all live there too), not
// apps/stingstream/docs/ -- which exists separately for app-specific docs
// (docs/conventions/, tv-*.md). Two roots, used deliberately by outPath's callers below.
const REPO_ROOT = join(APP_ROOT, "..", "..");
const SOURCE_DIR = join(APP_ROOT, "assets", "brand", "source");

const MARK_SRC = join(SOURCE_DIR, SOURCE_FILES.mark);
const WORDMARK_SRC = join(SOURCE_DIR, SOURCE_FILES.wordmark);

const ASPECTS: BrandAspects = {
  mark: MARK_SIZE.width / MARK_SIZE.height,
  wordmark: WORDMARK_SIZE.width / WORDMARK_SIZE.height,
};

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 } as const;

function outPath(...segments: string[]): string {
  const p = join(APP_ROOT, ...segments);
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

function repoOutPath(...segments: string[]): string {
  const p = join(REPO_ROOT, ...segments);
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

function relLabel(path: string): string {
  return path
    .replace(`${APP_ROOT}\\`, "")
    .replace(`${APP_ROOT}/`, "")
    .replace(`${REPO_ROOT}\\`, "")
    .replace(`${REPO_ROOT}/`, "");
}

// ---------------------------------------------------------------------------
// Raster composition. Every output is the same two source images placed on a
// canvas -- no transform baked into the art itself, so source.ts stays the
// single source of truth and each asset is just a different placement.
// ---------------------------------------------------------------------------

/** Resize art to exactly w x h. Callers always pass a box of the art's own aspect. */
function resized(art: string | Buffer, w: number, h: number) {
  return sharp(art).resize({
    width: Math.max(1, Math.round(w)),
    height: Math.max(1, Math.round(h)),
    fit: "fill",
    kernel: sharp.kernel.lanczos3,
  });
}

function blankCanvas(width: number, height: number, bg?: string) {
  return sharp({
    create: {
      width: Math.round(width),
      height: Math.round(height),
      channels: 4,
      background: bg ?? TRANSPARENT,
    },
  });
}

/**
 * The mark centred in a square canvas, occupying `boxFrac` of it. `boxFrac` is the
 * safe-zone contract for each platform (Android masks an adaptive icon down to ~66%,
 * iOS rounds its corners, a favicon has no mask at all), so the values are carried over
 * from the vector generator unchanged.
 */
async function markSquare(opts: {
  size: number;
  boxFrac: number;
  bg?: string;
  art?: string | Buffer;
}): Promise<Buffer> {
  const { size, boxFrac, bg, art = MARK_SRC } = opts;
  const box = size * boxFrac;
  // Fit the long edge to the box. The mark is taller than it is wide, so today that is
  // always the height -- but reading it off the aspect means a re-rendered, wider mark
  // would still be contained rather than silently cropped by the canvas.
  const height = ASPECTS.mark <= 1 ? box : box / ASPECTS.mark;
  const inner = await resized(art, height * ASPECTS.mark, height)
    .png()
    .toBuffer();
  return blankCanvas(size, size, bg)
    .composite([{ input: inner, gravity: "centre" }])
    .png()
    .toBuffer();
}

/** A lockup rasterised at `scale` layout-units-to-pixels, on a transparent canvas. */
async function renderLockup(
  layout: WordmarkLockup,
  scale: number,
  wordmarkArt: string | Buffer,
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const width = Math.round(layout.width * scale);
  const height = Math.round(layout.height * scale);
  const mark = await resized(
    MARK_SRC,
    layout.mark.width * scale,
    layout.mark.height * scale,
  )
    .png()
    .toBuffer();
  const word = await resized(
    wordmarkArt,
    layout.wordmark.width * scale,
    layout.wordmark.height * scale,
  )
    .png()
    .toBuffer();
  const buffer = await blankCanvas(width, height)
    .composite([
      {
        input: mark,
        left: Math.round(layout.mark.x * scale),
        top: Math.round(layout.mark.y * scale),
      },
      {
        input: word,
        left: Math.round(layout.wordmark.x * scale),
        top: Math.round(layout.wordmark.y * scale),
      },
    ])
    .png()
    .toBuffer();
  return { buffer, width, height };
}

/** A lockup scaled to fit a fixed canvas, centred, with the given padding and background. */
async function lockupOnCanvas(opts: {
  canvasW: number;
  canvasH: number;
  bg: string;
  layout: WordmarkLockup;
  wordmarkArt?: string | Buffer;
  paddingFrac?: number;
}): Promise<Buffer> {
  const {
    canvasW,
    canvasH,
    bg,
    layout,
    wordmarkArt = WORDMARK_SRC,
    paddingFrac = 0.12,
  } = opts;
  const scale = Math.min(
    (canvasW * (1 - paddingFrac * 2)) / layout.width,
    (canvasH * (1 - paddingFrac * 2)) / layout.height,
  );
  const { buffer } = await renderLockup(layout, scale, wordmarkArt);
  return blankCanvas(canvasW, canvasH, bg)
    .composite([{ input: buffer, gravity: "centre" }])
    .png()
    .toBuffer();
}

/**
 * The monochrome silhouette: white ink shaped by the mark's own alpha, with the levels
 * from `source.ts` applied so the ribbons go solid and the outer glow halo is dropped.
 *
 * Android keeps only this shape -- it discards the color of a notification icon and
 * tints the alpha -- so a straight copy of the render's soft falloff would arrive as a
 * grey smear at 96px. The linear() maps `lo` to fully transparent and `hi` to fully
 * opaque; sharp clamps everything outside that.
 */
async function markMonoArt(): Promise<Buffer> {
  const { data, info } = await sharp(MARK_SRC)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const lo = MONO_ALPHA_LEVELS.lo * 255;
  const hi = MONO_ALPHA_LEVELS.hi * 255;
  // Built as a raw RGBA buffer rather than sharp's joinChannel: on a `create` canvas
  // that call is silently dropped (the pipeline comes back 3-channel and the silhouette
  // ships as an opaque white rectangle), which is exactly the kind of failure the
  // alpha assertions in assets/bundled-assets.test.ts now catch.
  const out = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const alpha = data[p * channels + 3];
    const levelled = ((alpha - lo) / (hi - lo)) * 255;
    out[p * 4] = 255;
    out[p * 4 + 1] = 255;
    out[p * 4 + 2] = 255;
    out[p * 4 + 3] = Math.round(Math.min(255, Math.max(0, levelled)));
  }
  return sharp(out, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * The wordmark recolored for a light background.
 *
 * Both halves need work, for opposite reasons. "Sting" is rendered near-white and
 * disappears on white, so it is repainted in the dark ink. "Stream" carries the
 * cyan-to-violet gradient, which used to be carried across untouched -- and measured
 * 3.22:1 on white, with its palest pixels at 1.11:1. It is darkened by capping HSL
 * lightness, so the hue and the saturation survive and it is still visibly the same
 * gradient, just one made of ink rather than of light.
 *
 * Selecting by saturation rather than by a hardcoded x split keeps this correct if the
 * art is ever re-rendered -- and the boundary is checked, not assumed, because a
 * wordmark whose halves overlapped would need a different approach entirely.
 */
async function wordmarkLightArt(): Promise<Buffer> {
  const { data, info } = await sharp(WORDMARK_SRC)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const saturation = (r: number, g: number, b: number) => {
    const max = Math.max(r, g, b);
    return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
  };

  // Column census: where does the colored half start, and where does the pale half end?
  let firstChromatic = width;
  let lastAchromatic = -1;
  for (let x = 0; x < width; x++) {
    let chromatic = 0;
    let achromatic = 0;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * channels;
      if (data[i + 3] < 40) continue;
      const s = saturation(data[i], data[i + 1], data[i + 2]);
      if (s > WORDMARK_SATURATION.chromatic) chromatic++;
      else if (s < WORDMARK_SATURATION.achromatic) achromatic++;
    }
    if (chromatic >= 3 && x < firstChromatic) firstChromatic = x;
    if (achromatic >= 3) lastAchromatic = x;
  }
  if (lastAchromatic >= firstChromatic) {
    throw new Error(
      `wordmark halves overlap (pale ink to x=${lastAchromatic}, color from x=${firstChromatic}); ` +
        "the light variant cannot be separated by saturation alone",
    );
  }

  // Everything left of the boundary is "Sting", so every visible pixel there is
  // recolored -- including the faintly tinted anti-aliased edges, which an
  // achromatic-only test leaves behind as a pale ghost of the original word. The
  // saturation check that remains is a guard against a stray colored pixel, not the
  // filter that decides what "Sting" is; the census above already decided that.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < firstChromatic; x++) {
      const i = (y * width + x) * channels;
      if (data[i + 3] === 0) continue;
      if (
        saturation(data[i], data[i + 1], data[i + 2]) >
        WORDMARK_SATURATION.chromatic
      )
        continue;
      data[i] = WORDMARK_LIGHT_INK.r;
      data[i + 1] = WORDMARK_LIGHT_INK.g;
      data[i + 2] = WORDMARK_LIGHT_INK.b;
    }
  }

  // "Stream": keep the hue, cap the lightness. Everything from the boundary
  // rightwards, including the anti-aliased edges, so the word darkens evenly
  // rather than growing a pale halo.
  for (let y = 0; y < height; y++) {
    for (let x = firstChromatic; x < width; x++) {
      const i = (y * width + x) * channels;
      if (data[i + 3] === 0) continue;
      const [r, g, b] = darkenForLight(data[i], data[i + 1], data[i + 2]);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/**
 * One pixel of "Stream", moved from light to ink.
 *
 * Round-trips through HSL and changes only two of the three: lightness is capped
 * at `maxLightness`, and saturation is floored at `minSaturation` because
 * darkening alone sends the pale cyan grey rather than deep teal. Hue is never
 * touched, which is what keeps the result the artwork's gradient rather than a
 * new one.
 */
function darkenForLight(
  r8: number,
  g8: number,
  b8: number,
): [number, number, number] {
  const r = r8 / 255;
  const g = g8 / 255;
  const b = b8 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));

  const nextL = Math.min(l, WORDMARK_LIGHT_CHROMA.maxLightness);
  // A greyscale pixel has no hue to preserve, so leave its saturation alone
  // rather than inventing a colour for it.
  const nextS = d === 0 ? s : Math.max(s, WORDMARK_LIGHT_CHROMA.minSaturation);

  const c = (1 - Math.abs(2 * nextL - 1)) * nextS;
  const x2 = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = nextL - c / 2;
  const [rp, gp, bp] =
    h < 60
      ? [c, x2, 0]
      : h < 120
        ? [x2, c, 0]
        : h < 180
          ? [0, c, x2]
          : h < 240
            ? [0, x2, c]
            : h < 300
              ? [x2, 0, c]
              : [c, 0, x2];
  return [
    Math.round((rp + m) * 255),
    Math.round((gp + m) * 255),
    Math.round((bp + m) * 255),
  ];
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

async function writePng(buffer: Buffer, path: string, opaque = false) {
  let pipeline = sharp(buffer);
  if (opaque) {
    pipeline = pipeline.flatten({ background: BRAND_BG }).removeAlpha();
  }
  await pipeline.png().toFile(path);
  console.log("wrote", relLabel(path));
}

/** Write the identical bytes to every path (e.g. an icon Expo's own web.favicon config
 * needs under assets/, duplicated under public/ for direct serving). */
async function writePngToPaths(
  buffer: Buffer,
  paths: string[],
  opaque = false,
) {
  let pipeline = sharp(buffer);
  if (opaque) {
    pipeline = pipeline.flatten({ background: BRAND_BG }).removeAlpha();
  }
  const out = await pipeline.png().toBuffer();
  for (const path of paths) {
    writeFileSync(path, out);
    console.log("wrote", relLabel(path));
  }
}

function writeText(content: string, path: string) {
  writeFileSync(path, content, "utf8");
  console.log("wrote", relLabel(path));
}

/**
 * Write a generated .ts file and immediately run `biome format --write` on it. The
 * generated constants file is machine-built and does not match biome's own formatting
 * rules -- `bun run check` (CI's "Formatter and lint" step, which runs biome over the
 * whole app, not just touched files) caught this once already (constants/brandPaths.ts).
 * Formatting it here, every time this script writes it, makes that a one-time bug rather
 * than a standing risk every future regeneration could reintroduce.
 */
function writeGeneratedTs(content: string, path: string) {
  writeFileSync(path, content, "utf8");
  execFileSync("bunx", ["biome", "format", "--write", path], {
    cwd: APP_ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  console.log("wrote", relLabel(path));
}

function brandAssetsModule(): string {
  return [
    "/**",
    " * Generated by `bun scripts/brand/generate.ts` from `scripts/brand/source.ts`.",
    " * Do not hand-edit -- change the source art and re-run the generator instead.",
    " *",
    " * The require()s are at module scope on purpose: eas-cli drops anything matching a",
    " * .gitignore rule from its upload, and a require inside a try/catch compiles to a",
    " * silent runtime throw rather than a failed build (see",
    " * `.claude/learned-facts/eas-archive-drops-gitignored-tracked-files`).",
    " * `assets/bundled-assets.test.ts` scans constants/ for these and pins them.",
    " */",
    "",
    'import type { BrandAspects } from "@/components/brand/wordmarkLayout";',
    "",
    'export const MARK_IMAGE = require("@/assets/brand/mark.png");',
    'export const MARK_MONO_IMAGE = require("@/assets/brand/mark-mono.png");',
    'export const WORDMARK_IMAGE = require("@/assets/brand/wordmark.png");',
    'export const WORDMARK_LIGHT_IMAGE = require("@/assets/brand/wordmark-light.png");',
    "",
    "/** Intrinsic width/height of each source image, for aspect-correct layout. */",
    "export const BRAND_ASPECTS: BrandAspects = {",
    `  mark: ${MARK_SIZE.width} / ${MARK_SIZE.height},`,
    `  wordmark: ${WORDMARK_SIZE.width} / ${WORDMARK_SIZE.height},`,
    "};",
    "",
    "/** The mark's own gradient. NOT the UI accent -- that stays teal in theme.tokens.json. */",
    `export const BRAND_ACCENT_FROM = ${JSON.stringify(BRAND_ACCENT.from)};`,
    `export const BRAND_ACCENT_TO = ${JSON.stringify(BRAND_ACCENT.to)};`,
    `export const BRAND_BG = ${JSON.stringify(BRAND_BG)};`,
    "",
  ].join("\n");
}

async function main() {
  const monoArt = await markMonoArt();
  const lightWordmark = await wordmarkLightArt();

  // ---- assets/brand/: the kit the app and the docs render ------------------
  await writePng(
    await sharp(MARK_SRC).png().toBuffer(),
    outPath("assets", "brand", "mark.png"),
  );
  await writePng(monoArt, outPath("assets", "brand", "mark-mono.png"));
  await writePng(
    await sharp(WORDMARK_SRC).png().toBuffer(),
    outPath("assets", "brand", "wordmark.png"),
  );
  await writePng(
    lightWordmark,
    outPath("assets", "brand", "wordmark-light.png"),
  );

  const stacked = stackedLayout(ASPECTS);
  const horizontal = horizontalLayout(ASPECTS);
  const stackedScale = 600 / stacked.width;
  for (const [file, art] of [
    ["lockup-stacked.png", WORDMARK_SRC],
    ["lockup-stacked-light.png", lightWordmark],
  ] as const) {
    const { buffer } = await renderLockup(stacked, stackedScale, art);
    await writePng(buffer, outPath("assets", "brand", file));
  }

  // ---- assets/images/*.png (native app icons) ------------------------------
  await writePng(
    await markSquare({ size: 1024, boxFrac: 0.82, bg: BRAND_BG }),
    outPath("assets", "images", "icon.png"),
    true,
  );
  await writePng(
    await markSquare({ size: 1024, boxFrac: 0.66 }),
    outPath("assets", "images", "icon-android-plain.png"),
  );
  await writePng(
    await markSquare({ size: 1024, boxFrac: 0.66, art: monoArt }),
    outPath("assets", "images", "icon-android-themed.png"),
  );
  await writePng(
    await markSquare({ size: 1024, boxFrac: 0.6 }),
    outPath("assets", "images", "icon-ios-plain.png"),
  );
  await writePng(
    await markSquare({ size: 96, boxFrac: 0.86, art: monoArt }),
    outPath("assets", "images", "notification.png"),
  );

  // ---- TV: in-app banner resource + home-row channel logo -----------------
  await writePng(
    await lockupOnCanvas({
      canvasW: 320,
      canvasH: 180,
      bg: BRAND_BG,
      layout: horizontal,
      paddingFrac: 0.16,
    }),
    outPath("assets", "images", "tv-banner-xhdpi.png"),
    true,
  );
  await writePng(
    await markSquare({ size: 320, boxFrac: 0.78, bg: BRAND_BG }),
    outPath("assets", "images", "tv-channel-logo.png"),
    true,
  );

  // ---- tvOS: app icon + Top Shelf ------------------------------------------
  // Apple wants these flat and opaque (the seven they replace were too). The app icons
  // are near-square, so they take the stacked lockup; Top Shelf is a wide banner, which
  // is what the horizontal lockup is for.
  for (const [file, w, h] of [
    ["icon-tvos.png", 1280, 768],
    ["icon-tvos-small.png", 400, 240],
    ["icon-tvos-small-2x.png", 800, 480],
  ] as const) {
    await writePng(
      await lockupOnCanvas({
        canvasW: w,
        canvasH: h,
        bg: BRAND_BG,
        layout: stacked,
        paddingFrac: 0.1,
      }),
      outPath("assets", "images", file),
      true,
    );
  }
  for (const [file, w, h] of [
    ["icon-tvos-topshelf.png", 1920, 720],
    ["icon-tvos-topshelf-2x.png", 3840, 1440],
    ["icon-tvos-topshelf-wide.png", 2320, 720],
    ["icon-tvos-topshelf-wide-2x.png", 4640, 1440],
  ] as const) {
    await writePng(
      await lockupOnCanvas({
        canvasW: w,
        canvasH: h,
        bg: BRAND_BG,
        layout: horizontal,
        paddingFrac: 0.16,
      }),
      outPath("assets", "images", file),
      true,
    );
  }

  // ---- docs/screenshots: Play listing assets -------------------------------
  await writePng(
    await lockupOnCanvas({
      canvasW: 1280,
      canvasH: 720,
      bg: BRAND_BG,
      layout: horizontal,
      paddingFrac: 0.16,
    }),
    repoOutPath("docs", "screenshots", "tv-banner.png"),
    true,
  );
  await writePng(
    await markSquare({ size: 512, boxFrac: 0.82, bg: BRAND_BG }),
    repoOutPath("docs", "screenshots", "icon-512.png"),
    true,
  );
  await writePng(
    await lockupOnCanvas({
      canvasW: 1024,
      canvasH: 500,
      bg: BRAND_BG,
      layout: horizontal,
      paddingFrac: 0.18,
    }),
    repoOutPath("docs", "screenshots", "feature-graphic.png"),
    true,
  );

  // ---- public/: web favicons + manifest ------------------------------------
  // Expo's own `web.favicon` config (app.json) needs its source under assets/ to run
  // through the normal asset pipeline; `public/` is copied byte for byte into `dist/`
  // and is what site.webmanifest and the <link> tags in app/+html.tsx point at for the
  // sizes Expo's single-favicon config doesn't cover. Same bytes, both places.
  const favicon192 = await markSquare({ size: 192, boxFrac: 0.86 });
  await writePngToPaths(favicon192, [
    outPath("assets", "images", "favicon-192.png"),
    outPath("public", "favicon-192.png"),
  ]);
  await writePngToPaths(await markSquare({ size: 32, boxFrac: 0.92 }), [
    outPath("assets", "images", "favicon-32.png"),
    outPath("public", "favicon-32.png"),
  ]);
  await writePngToPaths(
    await markSquare({ size: 180, boxFrac: 0.72, bg: BRAND_BG }),
    [
      outPath("assets", "images", "apple-touch-icon.png"),
      outPath("public", "apple-touch-icon.png"),
    ],
    true,
  );

  // The art is a render, so favicon.svg can only ever wrap the same pixels -- but it
  // stays, because a browser that asks for image/svg+xml then gets 192px instead of the
  // 32px .ico Expo generates from web.favicon, and it costs one <link>.
  writeText(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">',
      `  <image href="data:image/png;base64,${favicon192.toString("base64")}" width="192" height="192"/>`,
      "</svg>",
      "",
    ].join("\n"),
    outPath("public", "favicon.svg"),
  );

  writeText(
    `${JSON.stringify(
      {
        name: "StingStream",
        short_name: "StingStream",
        icons: [
          { src: "/favicon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
        ],
        theme_color: BRAND_ACCENT.from,
        background_color: BRAND_BG,
        display: "standalone",
      },
      null,
      2,
    )}\n`,
    outPath("public", "site.webmanifest"),
  );

  // ---- the gateway's first-paint splash ------------------------------------
  // Inlined rather than fetched: a splash that arrives in a second round trip has already
  // lost the race it exists to win. 144px for a 72px render on a 2x display.
  // `gateway/brand.rs` include_str!s this, so it is still compiled into the binary. No
  // trailing newline -- the constant goes straight into a data: URI.
  const splashBase64 = (await markSquare({ size: 144, boxFrac: 1 })).toString(
    "base64",
  );
  writeText(
    splashBase64,
    repoOutPath(
      "mesh",
      "crates",
      "stingstream",
      "src",
      "gateway",
      "mark.png.base64",
    ),
  );
  console.log(
    `  (splash mark: ${(splashBase64.length / 1024).toFixed(1)} KB base64)`,
  );

  // ---- constants/brandAssets.ts: the app-importable handle on the art -----
  writeGeneratedTs(brandAssetsModule(), outPath("constants", "brandAssets.ts"));

  console.log(
    "\nDone. Re-run `expo prebuild --clean` (or the release build script) to pick up the native icons.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
