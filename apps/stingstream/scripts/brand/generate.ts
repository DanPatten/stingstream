#!/usr/bin/env bun
/**
 * StingStream brand asset generator.
 *
 * Reads the mark (`mark.ts`) and wordmark (`wordmark.ts`) path data -- both static,
 * authored once, never regenerated from a live font or a design tool at build time --
 * and rasterises every icon, favicon, TV asset and store-listing image the app and its
 * docs reference, plus the standalone SVG lockups. Also (re)writes
 * `constants/brandPaths.ts`, the committed, app-importable copy of the same data that
 * `components/brand/*` renders from.
 *
 * Run once and commit the outputs:
 *   bun scripts/brand/generate.ts
 *
 * To re-render the three mark candidates and a contact sheet (used once, during the
 * mark's own review pass -- see `mark.ts`'s file comment) instead of the normal run:
 *   bun scripts/brand/generate.ts --candidates [--out <dir>]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";
import {
  BRAND_ACCENT,
  BRAND_BG,
  MARK_CANDIDATES,
  MARK_INK_BOUNDS,
  MARK_PATH_D,
  MARK_VIEWBOX_SIZE,
} from "./mark";
import {
  WORDMARK_TEXT_D,
  WORDMARK_TEXT_HEIGHT,
  WORDMARK_TEXT_TOP,
  WORDMARK_TEXT_WIDTH,
  WORDMARK_UNITS_PER_EM,
} from "./wordmark";

const APP_ROOT = join(__dirname, "..", "..");
// docs/screenshots/ is a top-level, monorepo-wide directory (docs/APP-RELEASE.md,
// deploy/play/checklist.md and its own README.md all live there too), not
// apps/stingstream/docs/ -- which exists separately for app-specific docs
// (docs/conventions/, tv-*.md). Two roots, used deliberately by outPath's callers below.
const REPO_ROOT = join(APP_ROOT, "..", "..");

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

// ---------------------------------------------------------------------------
// Small SVG-building helpers. Everything is composed with plain <g transform="
// translate(..) scale(..)"> wrappers around the two path constants -- no matrix
// math baked into the path data itself, so mark.ts/wordmark.ts stay the single
// source of truth and every rendered size/crop is just a different transform.
// ---------------------------------------------------------------------------

function gradientDefs(id = "g"): string {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BRAND_ACCENT.from}"/><stop offset="1" stop-color="${BRAND_ACCENT.to}"/></linearGradient>`;
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };

/** Scale+translate to fit `box` into a `size`x`size` square whose top-left is (x,y), centered, aspect preserved. */
function fitBoxIntoSquare(box: Box, x: number, y: number, size: number) {
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const scale = size / Math.max(w, h);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  return {
    scale,
    tx: x + size / 2 - cx * scale,
    ty: y + size / 2 - cy * scale,
  };
}

/** A single self-contained icon-shaped SVG: the mark centred in a `boxFrac` fraction of the canvas. */
function markSvg(opts: {
  canvas: number;
  fill: string;
  bg?: string;
  boxFrac?: number;
}): string {
  const { canvas, fill, bg, boxFrac = 0.82 } = opts;
  const inner = canvas * boxFrac;
  const off = (canvas - inner) / 2;
  const { scale, tx, ty } = fitBoxIntoSquare(MARK_INK_BOUNDS, off, off, inner);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">
  <defs>${gradientDefs()}</defs>
  ${bg ? `<rect width="${canvas}" height="${canvas}" fill="${bg}"/>` : ""}
  <g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})"><path d="${MARK_PATH_D}" fill="${fill}"/></g>
</svg>`;
}

/** The mark alone, tightly cropped to its own ink bounds (for favicon.svg). */
function markTightSvg(fill: string, paddingFrac = 0.08): string {
  const w = MARK_INK_BOUNDS.maxX - MARK_INK_BOUNDS.minX;
  const h = MARK_INK_BOUNDS.maxY - MARK_INK_BOUNDS.minY;
  const pad = Math.max(w, h) * paddingFrac;
  const minX = MARK_INK_BOUNDS.minX - pad;
  const minY = MARK_INK_BOUNDS.minY - pad;
  const vw = w + pad * 2;
  const vh = h + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(2)} ${minY.toFixed(2)} ${vw.toFixed(2)} ${vh.toFixed(2)}">
  <defs>${gradientDefs()}</defs>
  <path d="${MARK_PATH_D}" fill="${fill}"/>
</svg>`;
}

/** Mark + wordmark side by side, fit to a given icon-glyph height. Returns the group markup and its bounding box. */
function horizontalLockup(opts: {
  height: number;
  markFill: string;
  textFill: string;
  margin?: number;
}) {
  const { height: H, markFill, textFill, margin = H * 0.14 } = opts;
  const inkW = MARK_INK_BOUNDS.maxX - MARK_INK_BOUNDS.minX;
  const inkH = MARK_INK_BOUNDS.maxY - MARK_INK_BOUNDS.minY;
  const markScale = H / inkH;
  const markW = inkW * markScale;
  const { tx: markTx, ty: markTy } = fitBoxIntoSquare(
    MARK_INK_BOUNDS,
    margin,
    margin,
    H,
  );
  const gap = H * 0.3;
  const textScale = (H * 0.62) / WORDMARK_TEXT_HEIGHT;
  const textX = margin + markW + gap;
  const markCenterY = margin + H / 2;
  const textLocalCenterY = WORDMARK_TEXT_TOP + WORDMARK_TEXT_HEIGHT / 2;
  const baselineY = markCenterY - textScale * textLocalCenterY;
  const width = margin + markW + gap + textScale * WORDMARK_TEXT_WIDTH + margin;
  const heightTotal = H + margin * 2;
  const group = `<g transform="translate(${markTx.toFixed(2)} ${markTy.toFixed(2)}) scale(${markScale.toFixed(4)})"><path d="${MARK_PATH_D}" fill="${markFill}"/></g>
  <g transform="translate(${textX.toFixed(2)} ${baselineY.toFixed(2)}) scale(${textScale.toFixed(4)})"><path d="${WORDMARK_TEXT_D}" fill="${textFill}"/></g>`;
  return { group, width, height: heightTotal };
}

/** Mark above wordmark, both centred, fit to a given total width. */
function stackedLockup(opts: {
  width: number;
  markFill: string;
  textFill: string;
  margin?: number;
}) {
  const { width: W, markFill, textFill, margin = W * 0.08 } = opts;
  const contentW = W - margin * 2;
  const inkW = MARK_INK_BOUNDS.maxX - MARK_INK_BOUNDS.minX;
  const inkH = MARK_INK_BOUNDS.maxY - MARK_INK_BOUNDS.minY;
  const markW = contentW * 0.34;
  const markScale = markW / inkW;
  const markH = inkH * markScale;
  const { tx: markTx, ty: markTy } = fitBoxIntoSquare(
    MARK_INK_BOUNDS,
    margin + (contentW - markW) / 2,
    margin,
    markH,
  );
  const gap = markH * 0.32;
  const textScale = contentW / WORDMARK_TEXT_WIDTH;
  // The text's local baseline is y=0; its top sits at WORDMARK_TEXT_TOP (negative). To
  // place the top of the text block at (margin + markH + gap), the baseline must sit
  // `-textScale * WORDMARK_TEXT_TOP` further down.
  const baselineY = margin + markH + gap - textScale * WORDMARK_TEXT_TOP;
  const heightTotal =
    margin + markH + gap + textScale * WORDMARK_TEXT_HEIGHT + margin;
  const group = `<g transform="translate(${markTx.toFixed(2)} ${markTy.toFixed(2)}) scale(${markScale.toFixed(4)})"><path d="${MARK_PATH_D}" fill="${markFill}"/></g>
  <g transform="translate(${margin.toFixed(2)} ${baselineY.toFixed(2)}) scale(${textScale.toFixed(4)})"><path d="${WORDMARK_TEXT_D}" fill="${textFill}"/></g>`;
  return { group, width: W, height: heightTotal };
}

/** Wrap a lockup group in an outer canvas of a fixed size, centred with the given fill background. */
function composeOnCanvas(opts: {
  canvasW: number;
  canvasH: number;
  bg: string;
  content: { group: string; width: number; height: number };
  paddingFrac?: number;
}): string {
  const { canvasW, canvasH, bg, content, paddingFrac = 0.12 } = opts;
  const availW = canvasW * (1 - paddingFrac * 2);
  const availH = canvasH * (1 - paddingFrac * 2);
  const scale = Math.min(availW / content.width, availH / content.height);
  const w = content.width * scale;
  const h = content.height * scale;
  const x = (canvasW - w) / 2;
  const y = (canvasH - h) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}">
  <defs>${gradientDefs()}</defs>
  <rect width="${canvasW}" height="${canvasH}" fill="${bg}"/>
  <g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})">${content.group}</g>
</svg>`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function relLabel(path: string): string {
  return path
    .replace(`${APP_ROOT}\\`, "")
    .replace(`${APP_ROOT}/`, "")
    .replace(`${REPO_ROOT}\\`, "")
    .replace(`${REPO_ROOT}/`, "");
}

async function renderPng(
  svg: string,
  size: { w: number; h: number },
  path: string,
  opaque: boolean,
) {
  let pipeline = sharp(Buffer.from(svg)).resize(size.w, size.h);
  if (opaque) {
    pipeline = pipeline.flatten({ background: BRAND_BG }).removeAlpha();
  }
  await pipeline.png().toFile(path);
  console.log("wrote", relLabel(path));
}

/** Render once and write the identical bytes to every path in `paths` (e.g. an icon Expo's
 * own web.favicon config needs under assets/, duplicated under public/ for direct serving). */
async function renderPngToPaths(
  svg: string,
  size: { w: number; h: number },
  paths: string[],
  opaque: boolean,
) {
  let pipeline = sharp(Buffer.from(svg)).resize(size.w, size.h);
  if (opaque) {
    pipeline = pipeline.flatten({ background: BRAND_BG }).removeAlpha();
  }
  const buffer = await pipeline.png().toBuffer();
  for (const path of paths) {
    writeFileSync(path, buffer);
    console.log("wrote", relLabel(path));
  }
}

function writeSvg(svg: string, path: string) {
  writeFileSync(path, svg, "utf8");
  console.log(
    "wrote",
    path.replace(`${APP_ROOT}\\`, "").replace(`${APP_ROOT}/`, ""),
  );
}

async function runCandidatesPreview(outDir: string) {
  mkdirSync(outDir, { recursive: true });
  const sets: Record<string, string> = {
    1: MARK_CANDIDATES.rounder_softer_wing,
    2: MARK_PATH_D,
    3: MARK_CANDIDATES.bolder_crisp_wing,
  };
  const svgFor = (
    d: string,
    size: number,
    dark: boolean,
  ) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <defs>${gradientDefs()}</defs>
  <rect width="1024" height="1024" fill="${dark ? BRAND_BG : "#FFFFFF"}"/>
  <path d="${d}" fill="${dark ? "url(#g)" : BRAND_BG}"/>
</svg>`;
  for (const [id, d] of Object.entries(sets)) {
    for (const size of [48, 512] as const) {
      for (const dark of [true, false]) {
        const name = `candidate-${id}-${size}-${dark ? "dark" : "light"}.png`;
        await sharp(Buffer.from(svgFor(d, 1024, dark)))
          .resize(size, size)
          .png()
          .toFile(join(outDir, name));
      }
    }
  }
  const cell = 300;
  const composites = [];
  const ids = ["1", "2", "3"];
  for (let i = 0; i < ids.length; i++) {
    const darkBuf = await sharp(
      join(outDir, `candidate-${ids[i]}-512-dark.png`),
    )
      .resize(cell, cell)
      .toBuffer();
    const lightBuf = await sharp(
      join(outDir, `candidate-${ids[i]}-512-light.png`),
    )
      .resize(cell, cell)
      .toBuffer();
    composites.push({ input: darkBuf, left: i * cell, top: 0 });
    composites.push({ input: lightBuf, left: i * cell, top: cell });
  }
  await sharp({
    create: {
      width: cell * 3,
      height: cell * 2,
      channels: 4,
      background: "#333333",
    },
  })
    .composite(composites)
    .png()
    .toFile(join(outDir, "contact-sheet.png"));
  console.log("wrote", join(outDir, "contact-sheet.png"));
}

async function main() {
  if (process.argv.includes("--candidates")) {
    const outFlagIdx = process.argv.indexOf("--out");
    const outDir =
      outFlagIdx >= 0 && process.argv[outFlagIdx + 1]
        ? process.argv[outFlagIdx + 1]
        : "E:\\Dan\\Documents\\Repos\\.win-temp\\ui-loop\\handoff\\brand";
    await runCandidatesPreview(outDir);
    return;
  }

  // ---- assets/brand/*.svg -------------------------------------------------
  writeSvg(
    markSvg({ canvas: MARK_VIEWBOX_SIZE, fill: "url(#g)", boxFrac: 0.86 }),
    outPath("assets", "brand", "stingstream-mark.svg"),
  );
  writeSvg(
    markSvg({ canvas: MARK_VIEWBOX_SIZE, fill: "#FFFFFF", boxFrac: 0.86 }),
    outPath("assets", "brand", "stingstream-mark-mono.svg"),
  );

  const horiz = horizontalLockup({
    height: 200,
    markFill: "url(#g)",
    textFill: "#F2F3F5",
  });
  writeSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${horiz.width.toFixed(0)}" height="${horiz.height.toFixed(0)}" viewBox="0 0 ${horiz.width.toFixed(2)} ${horiz.height.toFixed(2)}">
  <defs>${gradientDefs()}</defs>
  ${horiz.group}
</svg>`,
    outPath("assets", "brand", "stingstream-wordmark.svg"),
  );

  const stacked = stackedLockup({
    width: 600,
    markFill: "url(#g)",
    textFill: "#F2F3F5",
  });
  writeSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${stacked.width.toFixed(0)}" height="${stacked.height.toFixed(0)}" viewBox="0 0 ${stacked.width.toFixed(2)} ${stacked.height.toFixed(2)}">
  <defs>${gradientDefs()}</defs>
  ${stacked.group}
</svg>`,
    outPath("assets", "brand", "stingstream-wordmark-stacked.svg"),
  );

  // ---- assets/images/*.png (native app icons) ------------------------------
  await renderPng(
    markSvg({ canvas: 1024, fill: "url(#g)", bg: BRAND_BG, boxFrac: 0.82 }),
    { w: 1024, h: 1024 },
    outPath("assets", "images", "icon.png"),
    true,
  );
  await renderPng(
    markSvg({ canvas: 1024, fill: "url(#g)", boxFrac: 0.66 }),
    { w: 1024, h: 1024 },
    outPath("assets", "images", "icon-android-plain.png"),
    false,
  );
  await renderPng(
    markSvg({ canvas: 1024, fill: "#FFFFFF", boxFrac: 0.66 }),
    { w: 1024, h: 1024 },
    outPath("assets", "images", "icon-android-themed.png"),
    false,
  );
  await renderPng(
    markSvg({ canvas: 1024, fill: "url(#g)", boxFrac: 0.6 }),
    { w: 1024, h: 1024 },
    outPath("assets", "images", "icon-ios-plain.png"),
    false,
  );
  await renderPng(
    markSvg({ canvas: 96, fill: "#FFFFFF", boxFrac: 0.86 }),
    { w: 96, h: 96 },
    outPath("assets", "images", "notification.png"),
    false,
  );

  // ---- TV: in-app banner resource + home-row channel logo -----------------
  const tvBannerContent = horizontalLockup({
    height: 100,
    markFill: "#FFFFFF",
    textFill: "#FFFFFF",
  });
  await renderPng(
    composeOnCanvas({
      canvasW: 320,
      canvasH: 180,
      bg: BRAND_BG,
      content: tvBannerContent,
      paddingFrac: 0.16,
    }),
    { w: 320, h: 180 },
    outPath("assets", "images", "tv-banner-xhdpi.png"),
    true,
  );
  await renderPng(
    markSvg({ canvas: 320, fill: "url(#g)", bg: BRAND_BG, boxFrac: 0.78 }),
    { w: 320, h: 320 },
    outPath("assets", "images", "tv-channel-logo.png"),
    true,
  );

  // ---- docs/screenshots: Play listing assets -------------------------------
  const tvBannerLarge = horizontalLockup({
    height: 380,
    markFill: "#FFFFFF",
    textFill: "#FFFFFF",
  });
  await renderPng(
    composeOnCanvas({
      canvasW: 1280,
      canvasH: 720,
      bg: BRAND_BG,
      content: tvBannerLarge,
      paddingFrac: 0.16,
    }),
    { w: 1280, h: 720 },
    repoOutPath("docs", "screenshots", "tv-banner.png"),
    true,
  );
  await renderPng(
    markSvg({ canvas: 512, fill: "url(#g)", bg: BRAND_BG, boxFrac: 0.82 }),
    { w: 512, h: 512 },
    repoOutPath("docs", "screenshots", "icon-512.png"),
    true,
  );
  const featureContent = horizontalLockup({
    height: 220,
    markFill: "url(#g)",
    textFill: "#F2F3F5",
  });
  await renderPng(
    composeOnCanvas({
      canvasW: 1024,
      canvasH: 500,
      bg: BRAND_BG,
      content: featureContent,
      paddingFrac: 0.18,
    }),
    { w: 1024, h: 500 },
    repoOutPath("docs", "screenshots", "feature-graphic.png"),
    true,
  );

  // ---- public/: web favicons + manifest ------------------------------------
  // Expo's own `web.favicon` config (app.json) needs its source under assets/ to run
  // through the normal asset pipeline; `public/` is copied byte for byte into `dist/`
  // (verified separately) and is what site.webmanifest and any extra <link> tags point
  // at for sizes Expo's single-favicon config doesn't cover. Same bytes, both places.
  writeSvg(markTightSvg("url(#g)"), outPath("public", "favicon.svg"));
  await renderPngToPaths(
    markSvg({ canvas: 32, fill: "url(#g)", boxFrac: 0.92 }),
    { w: 32, h: 32 },
    [
      outPath("assets", "images", "favicon-32.png"),
      outPath("public", "favicon-32.png"),
    ],
    false,
  );
  await renderPngToPaths(
    markSvg({ canvas: 192, fill: "url(#g)", boxFrac: 0.86 }),
    { w: 192, h: 192 },
    [
      outPath("assets", "images", "favicon-192.png"),
      outPath("public", "favicon-192.png"),
    ],
    false,
  );
  await renderPngToPaths(
    markSvg({ canvas: 180, fill: "url(#g)", bg: BRAND_BG, boxFrac: 0.72 }),
    { w: 180, h: 180 },
    [
      outPath("assets", "images", "apple-touch-icon.png"),
      outPath("public", "apple-touch-icon.png"),
    ],
    true,
  );
  writeFileSync(
    outPath("public", "site.webmanifest"),
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
    "utf8",
  );
  console.log("wrote public/site.webmanifest");

  // ---- constants/brandPaths.ts: the app-importable copy of the data above -
  const genLine = "Generated by `bun scripts/brand/generate.ts`";
  const constantsContent = [
    "/**",
    ` * ${genLine} from \`scripts/brand/mark.ts\` and \`scripts/brand/wordmark.ts\`.`,
    " * Do not hand-edit -- change those files and re-run the generator instead.",
    " */",
    "",
    `export const MARK_VIEWBOX = "0 0 ${MARK_VIEWBOX_SIZE} ${MARK_VIEWBOX_SIZE}";`,
    `export const MARK_PATH_D = ${JSON.stringify(MARK_PATH_D)};`,
    "",
    `export const BRAND_ACCENT_FROM = ${JSON.stringify(BRAND_ACCENT.from)};`,
    `export const BRAND_ACCENT_TO = ${JSON.stringify(BRAND_ACCENT.to)};`,
    `export const BRAND_BG = ${JSON.stringify(BRAND_BG)};`,
    "",
    `export const WORDMARK_UNITS_PER_EM = ${WORDMARK_UNITS_PER_EM};`,
    `export const WORDMARK_TEXT_D = ${JSON.stringify(WORDMARK_TEXT_D)};`,
    `export const WORDMARK_TEXT_WIDTH = ${WORDMARK_TEXT_WIDTH};`,
    `export const WORDMARK_TEXT_HEIGHT = ${WORDMARK_TEXT_HEIGHT};`,
    `export const WORDMARK_TEXT_TOP = ${WORDMARK_TEXT_TOP};`,
    "",
    "/** Tight ink bounding box of MARK_PATH_D within its viewBox, for lockup layout. */",
    `export const MARK_INK_BOUNDS = ${JSON.stringify(MARK_INK_BOUNDS)};`,
    "",
  ].join("\n");
  writeFileSync(
    outPath("constants", "brandPaths.ts"),
    constantsContent,
    "utf8",
  );
  console.log("wrote constants/brandPaths.ts");

  console.log(
    "\nDone. Re-run `expo prebuild --clean` (or the release build script) to pick up the native icons.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
