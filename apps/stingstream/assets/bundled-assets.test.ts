import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ignore from "ignore";

// EAS Build never sees a working tree. eas-cli archives the project first and
// drops every path that matches .gitignore, tracked or not, so a force-added
// file is silently left behind. Metro then compiles a require() that cannot be
// resolved into a runtime throw when it sits inside try/catch (an optional
// dependency), so the build stays green and the asset first goes missing on
// TestFlight. That is how the subtitle preview shipped as "Failed to load
// preview": `*.mp4` is ignored and assets/sample_subtitled.mp4 was force-added.
//
// These tests pin every asset the JS bundle requires: it has to exist, and the
// ignore rules eas-cli applies must not match it. The rules are evaluated with
// the same `ignore` package eas-cli uses, in-process: bun's test discovery
// leaves thousands of file descriptors open, which breaks the stdio of any
// child process a test spawns, so `git check-ignore` is not an option here.

const root = join(__dirname, "..");
const SOURCE_DIRS = [
  "app",
  "components",
  "constants",
  "hooks",
  "modules",
  "providers",
  "utils",
];
const SOURCE_FILE = /\.tsx?$/;
const ASSET_REQUIRE = /require\(\s*["']@\/(assets\/[^"']+)["']\s*\)/g;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(path);
    }
    return SOURCE_FILE.test(entry.name) ? [path] : [];
  });

const requiredAssets = [
  ...new Set(
    SOURCE_DIRS.flatMap((dir) => sourceFiles(join(root, dir))).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(ASSET_REQUIRE)].map(
        (match) => match[1],
      ),
    ),
  ),
].sort();

/** "" (the root) and every directory between it and the file. */
const parentDirs = (file: string): string[] => {
  const parts = file.split("/").slice(0, -1);
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
};

/**
 * Whether eas-cli would leave the file out of the upload. Every .gitignore
 * between the repository root and the file applies, relative to its own
 * directory, and a rule in a parent file wins over an exception in a child
 * file — so any match ignores (mirror of eas-cli's vcs/local Ignore class).
 */
const droppedByEas = (file: string): boolean =>
  parentDirs(file).some((dir) => {
    const rules = join(root, dir, ".gitignore");
    if (!existsSync(rules)) return false;
    const relativePath = dir ? relative(dir, file) : file;
    return ignore().add(readFileSync(rules, "utf8")).ignores(relativePath);
  });

describe("assets required by the JS bundle survive an EAS build", () => {
  test("the scan finds the assets it is meant to guard", () => {
    expect(requiredAssets).toContain("assets/sample_subtitled.mp4");
  });

  test("every required asset exists", () => {
    const absent = requiredAssets.filter(
      (asset) => !existsSync(join(root, asset)),
    );
    expect(absent).toEqual([]);
  });

  test("no required asset matches an ignore rule", () => {
    // A non-empty list here names files EAS will drop from the upload even
    // though git tracks them; re-include each one below the rule it matches.
    expect(requiredAssets.filter(droppedByEas)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Brand assets: everything `scripts/brand/generate.ts` writes. Pinned by hand
// (not scanned like the require()s above, since most of these are referenced
// only by app.json/native config, not by a JS require) so a partial or
// forgotten re-run of the generator fails a fast, offline test instead of
// surfacing as a missing icon in a build days later. Dimensions are read
// straight from each PNG's IHDR chunk rather than through `sharp` -- `sharp`
// is a devDependency for the generator, not something this test suite should
// need to decode a 24-byte header.

type PngSpec = { width: number; height: number; opaque?: boolean };

/** True PNG signature + IHDR at a fixed offset (spec-guaranteed): read once, trust it. */
function readPngIHDR(path: string): {
  width: number;
  height: number;
  colorType: number;
} {
  const fd = readFileSync(path);
  const signature = fd.subarray(0, 8);
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (!signature.equals(pngSignature)) {
    throw new Error(`${path}: not a PNG (bad signature)`);
  }
  const chunkType = fd.subarray(12, 16).toString("ascii");
  if (chunkType !== "IHDR") {
    throw new Error(`${path}: first chunk is "${chunkType}", expected IHDR`);
  }
  return {
    width: fd.readUInt32BE(16),
    height: fd.readUInt32BE(20),
    colorType: fd.readUInt8(25),
  };
}

// PNG colour types with an alpha channel: 4 (greyscale+alpha), 6 (truecolour+alpha).
const ALPHA_COLOR_TYPES = new Set([4, 6]);

const BRAND_SVGS = [
  "assets/brand/stingstream-mark.svg",
  "assets/brand/stingstream-mark-mono.svg",
  "assets/brand/stingstream-wordmark.svg",
  "assets/brand/stingstream-wordmark-stacked.svg",
  "public/favicon.svg",
];

const BRAND_PNGS: Record<string, PngSpec> = {
  "assets/images/icon.png": { width: 1024, height: 1024, opaque: true },
  "assets/images/icon-android-plain.png": { width: 1024, height: 1024 },
  "assets/images/icon-android-themed.png": { width: 1024, height: 1024 },
  "assets/images/icon-ios-plain.png": { width: 1024, height: 1024 },
  "assets/images/notification.png": { width: 96, height: 96 },
  "assets/images/tv-banner-xhdpi.png": {
    width: 320,
    height: 180,
    opaque: true,
  },
  "assets/images/tv-channel-logo.png": {
    width: 320,
    height: 320,
    opaque: true,
  },
  "assets/images/favicon-32.png": { width: 32, height: 32 },
  "assets/images/favicon-192.png": { width: 192, height: 192 },
  "assets/images/apple-touch-icon.png": {
    width: 180,
    height: 180,
    opaque: true,
  },
  "public/favicon-32.png": { width: 32, height: 32 },
  "public/favicon-192.png": { width: 192, height: 192 },
  "public/apple-touch-icon.png": { width: 180, height: 180, opaque: true },
  "docs/screenshots/tv-banner.png": { width: 1280, height: 720, opaque: true },
  "docs/screenshots/icon-512.png": { width: 512, height: 512, opaque: true },
  "docs/screenshots/feature-graphic.png": {
    width: 1024,
    height: 500,
    opaque: true,
  },
};

const BRAND_OTHER = ["public/site.webmanifest", "constants/brand/paths.ts"];

// docs/screenshots/ is a top-level, monorepo-wide directory, two levels above `root`
// (apps/stingstream) -- not apps/stingstream/docs/, which exists separately for
// app-specific docs. `scripts/brand/generate.ts` writes there via its own `repoOutPath`;
// mirror that here rather than resolving every brand asset against the same root.
const repoRoot = join(root, "..", "..");
const brandAssetPath = (asset: string) =>
  join(asset.startsWith("docs/screenshots/") ? repoRoot : root, asset);

describe("brand assets `scripts/brand/generate.ts` writes", () => {
  test("every brand SVG exists", () => {
    const absent = BRAND_SVGS.filter(
      (asset) => !existsSync(brandAssetPath(asset)),
    );
    expect(absent).toEqual([]);
  });

  test("every brand PNG exists at its required dimensions", () => {
    const problems = Object.entries(BRAND_PNGS).flatMap(([asset, spec]) => {
      const path = brandAssetPath(asset);
      if (!existsSync(path)) return [`${asset}: missing`];
      const { width, height } = readPngIHDR(path);
      return width === spec.width && height === spec.height
        ? []
        : [
            `${asset}: expected ${spec.width}x${spec.height}, got ${width}x${height}`,
          ];
    });
    expect(problems).toEqual([]);
  });

  test("PNGs that must have no alpha channel (opaque store/launcher assets) don't have one", () => {
    const problems = Object.entries(BRAND_PNGS)
      .filter(([, spec]) => spec.opaque)
      .flatMap(([asset]) => {
        const { colorType } = readPngIHDR(brandAssetPath(asset));
        return ALPHA_COLOR_TYPES.has(colorType) ? [asset] : [];
      });
    expect(problems).toEqual([]);
  });

  test("the generated constants file and web manifest exist", () => {
    const absent = BRAND_OTHER.filter(
      (asset) => !existsSync(brandAssetPath(asset)),
    );
    expect(absent).toEqual([]);
  });

  test("the old PowerShell generator and its retired assets are gone", () => {
    expect(existsSync(join(root, "scripts", "generate-brand-assets.ps1"))).toBe(
      false,
    );
    expect(existsSync(join(root, "assets", "images", "splash.png"))).toBe(
      false,
    );
    expect(
      existsSync(join(root, "assets", "images", "streamyfin-client-badge.png")),
    ).toBe(false);
  });
});
