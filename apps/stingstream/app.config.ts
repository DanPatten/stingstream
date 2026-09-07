// Registers the tsx require hook so the TypeScript config plugins referenced
// from app.json ("./plugins/*.ts") can be loaded by Node during config evaluation.
import "tsx/cjs";
import { execFileSync } from "node:child_process";
import type { ConfigContext, ExpoConfig } from "expo/config";

// Build metadata, injected into `extra.build` and read at runtime via
// expo-constants (see utils/version.ts). Sources in priority order:
// EAS cloud build → GitHub Actions → explicit EXPO_PUBLIC_* → local git → null.
const git = (args: string[]): string | null => {
  try {
    return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

const buildMeta = {
  commit:
    (
      process.env.EAS_BUILD_GIT_COMMIT_HASH ||
      process.env.GITHUB_SHA ||
      process.env.EXPO_PUBLIC_GIT_COMMIT ||
      git(["rev-parse", "HEAD"]) ||
      ""
    ).slice(0, 7) || null,
  branch:
    process.env.EAS_BUILD_GIT_BRANCH ||
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    process.env.EXPO_PUBLIC_GIT_BRANCH ||
    git(["rev-parse", "--abbrev-ref", "HEAD"]) ||
    null,
  profile:
    process.env.EAS_BUILD_PROFILE ||
    process.env.EXPO_PUBLIC_BUILD_PROFILE ||
    null,
  // GitHub Actions run number (#2098) — lets anyone map a sideloaded CI build back
  // to its Actions run (artifacts + logs) without Expo access. Null outside CI.
  runNumber:
    process.env.GITHUB_RUN_NUMBER ||
    process.env.EXPO_PUBLIC_GIT_RUN_NUMBER ||
    null,
  builtAt: new Date().toISOString(),
};

export default ({ config }: ConfigContext): ExpoConfig => {
  if (process.env.EXPO_TV !== "1") {
    config.plugins?.push("expo-background-task");

    config.plugins?.push([
      "react-native-google-cast",
      { useDefaultExpandedMediaControls: true },
    ]);

    config.plugins?.push([
      "expo-camera",
      {
        cameraPermission:
          "Allow StingStream to access the camera to scan QR codes for TV login.",
      },
    ]);
  }

  // Sentry source-map/dSYM upload needs SENTRY_AUTH_TOKEN; without it the
  // injected build phases fail Release builds outright. Disable upload unless
  // the token is present (EAS secret / CI env), so it self-enables with it.
  for (const plugin of config.plugins ?? []) {
    if (Array.isArray(plugin) && plugin[0] === "@sentry/react-native/expo") {
      plugin[1] = {
        ...plugin[1],
        disableAutoUpload: !process.env.SENTRY_AUTH_TOKEN,
      };
    }
  }

  // Only override googleServicesFile if env var is set
  const androidConfig: { googleServicesFile?: string } = {};
  if (process.env.GOOGLE_SERVICES_JSON) {
    androidConfig.googleServicesFile = process.env.GOOGLE_SERVICES_JSON;
  }

  config.extra = { ...config.extra, build: buildMeta };

  // ProfileHeader's version pill on web (components/settings/ProfileHeader.tsx). `Constants.
  // expoConfig`/`Constants.manifest` resolve through `process.env.APP_MANIFEST` there — a
  // babel-preset-expo injection baked in at Metro bundle time from whatever app.json looked
  // like when that module was last transformed, and persistent-cache staleness is a real,
  // observed failure mode (a version bump landing in app.json and a later `expo export` still
  // reading the old one). `EXPO_PUBLIC_*` goes through Expo's own, single-purpose inline-env-var
  // transform instead — set here, before Metro reads a single source file, so the web build
  // always carries the version this exact config resolved, never a cached one.
  if (config.version) {
    process.env.EXPO_PUBLIC_APP_VERSION = config.version;
  }

  return {
    ...(Object.keys(androidConfig).length > 0 && { android: androidConfig }),
    ...config,
  } as ExpoConfig;
};
