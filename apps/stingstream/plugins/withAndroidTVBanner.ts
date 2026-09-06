import fs from "node:fs";
import path from "node:path";
import {
  AndroidConfig,
  type ConfigPlugin,
  withAndroidManifest,
} from "expo/config-plugins";

const fsPromises = fs.promises;

const { getMainApplicationOrThrow } = AndroidConfig.Manifest;

type AndroidManifest = AndroidConfig.Manifest.AndroidManifest;

/**
 * Google's Android TV listing rejects an app with no `android:banner` on the
 * <application> element, and the Play Console error for it does not name the missing
 * attribute (`deploy/play/checklist.md` §8). This plugin copies the two TV-only raster
 * assets `generate.ts` produces into `res/drawable-xhdpi/` and wires the banner into the
 * manifest, following the same copy-a-resource-into-place pattern as
 * `withTrustLocalCerts.ts`.
 *
 * `tv_banner.png` (from `assets/images/tv-banner-xhdpi.png`) is the 320x180 banner shown
 * in the Android TV / Google TV launcher row. `tv_channel_logo.png` (from
 * `assets/images/tv-channel-logo.png`) is the square mark used as the logo for this
 * app's entry in the "Continue watching" home-row channel
 * (`modules/tv-recommendations`'s `TvRecommendationsPublisher.kt`); it is copied here
 * rather than loaded at runtime because that module already reads the *application*
 * icon by package name when no channel-specific drawable exists, and a bundled resource
 * is simpler and faster than fetching one over the network for a launcher row.
 */
const withAndroidTVBanner: ConfigPlugin = (config) => {
  return withAndroidManifest(config, async (mod) => {
    await copyDrawables(mod.modRequest.projectRoot);
    mod.modResults = setBanner(mod.modResults);
    return mod;
  });
};

async function copyDrawables(projectRoot: string): Promise<void> {
  const resDir = await AndroidConfig.Paths.getResourceFolderAsync(projectRoot);
  const drawableDir = path.join(resDir, "drawable-xhdpi");
  if (!fs.existsSync(drawableDir)) {
    await fsPromises.mkdir(drawableDir, { recursive: true });
  }

  const copies: Array<[source: string, dest: string]> = [
    [
      path.join(projectRoot, "assets", "images", "tv-banner-xhdpi.png"),
      path.join(drawableDir, "tv_banner.png"),
    ],
    [
      path.join(projectRoot, "assets", "images", "tv-channel-logo.png"),
      path.join(drawableDir, "tv_channel_logo.png"),
    ],
  ];

  for (const [source, dest] of copies) {
    try {
      await fsPromises.copyFile(source, dest);
    } catch (e) {
      throw new Error(
        `Failed to copy TV drawable from ${source} to ${dest}. [Hint: run "bun scripts/brand/generate.ts" first so both files exist under assets/images/]`,
        { cause: e },
      );
    }
  }
}

function setBanner(androidManifest: AndroidManifest): AndroidManifest {
  const mainApplication = getMainApplicationOrThrow(androidManifest);
  mainApplication.$["android:banner"] = "@drawable/tv_banner";
  return androidManifest;
}

export default withAndroidTVBanner;
