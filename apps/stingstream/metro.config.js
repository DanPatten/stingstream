// Learn more https://docs.expo.io/guides/customizing-metro
// getSentryExpoConfig wraps expo/metro-config's getDefaultConfig and adds
// debug-ID injection so uploaded source maps match released bundles.
const { getSentryExpoConfig } = require("@sentry/react-native/metro");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getSentryExpoConfig(__dirname);

// Add Hermes parser
config.transformer.hermesParser = true;

// When enabled, the optional code below will allow Metro to resolve
// and bundle source files with TV-specific extensions
// (e.g., *.ios.tv.tsx, *.android.tv.tsx, *.tv.tsx)
//
// Metro will still resolve source files with standard extensions
// as usual if TV-specific files are not found for a module.
//
if (process.env?.EXPO_TV === "1") {
  const originalSourceExts = config.resolver.sourceExts;
  const tvSourceExts = [
    ...originalSourceExts.map((e) => `tv.${e}`),
    ...originalSourceExts,
  ];
  config.resolver.sourceExts = tvSourceExts;
}

// ---------------------------------------------------------------------------
// StingStream M2 — web target.
//
// Native-only packages that have no web implementation are redirected to a stub
// under `lib/platform/web-stubs/` *only* when Metro is bundling for the web.
// Every other platform (including the EXPO_TV=1 variant) goes through the
// untouched default resolver, so native resolution is bit-for-bit as before.
//
// Keep this list in sync with `docs/M2-web-spike.md`.
// ---------------------------------------------------------------------------
const path = require("node:path");

const webModuleStubs = {
  // Git dependency: its `main` points at a `lib/` build output that only exists
  // after its `prepare` script runs, and it is a pure native module regardless.
  "react-native-track-player": "react-native-track-player.ts",
  // Chromecast sender SDK — Android/iOS only. Web casting would use the Cast
  // Web Sender API instead; not part of the spike.
  "react-native-google-cast": "react-native-google-cast.ts",
  // Native platform tab bar (UITabBarController / BottomNavigationView). Its
  // fabric component imports react-native internals Metro refuses on web.
  "@bottom-tabs/react-navigation": "bottom-tabs-react-navigation.tsx",
  // SwiftUI bridge. Three components already lazy-require it, but behind a
  // `Platform.isTV` guard that is false on web, so the require still runs.
  "@expo/ui/swift-ui": "expo-ui-swift-ui.js",
  "@expo/ui/swift-ui/modifiers": "expo-ui-swift-ui.js",
  // expo-file-system 57 ships an *empty* web backend, so the first
  // `new Directory(Paths.document, ...)` throws before the app can mount.
  "expo-file-system": "expo-file-system.ts",
  // Lazy-required behind a `Platform.isTV` guard that is false on web, so the
  // real module loads and throws UnavailabilityError *synchronously* inside
  // the root layout effect, aborting the rest of it.
  "expo-notifications": "expo-notifications.ts",
};

const stubRoot = path.resolve(__dirname, "lib/platform/web-stubs");
const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web") {
    const stub = webModuleStubs[moduleName];
    if (stub) {
      return { type: "sourceFile", filePath: path.join(stubRoot, stub) };
    }
  }
  return (defaultResolveRequest ?? context.resolveRequest)(
    context,
    moduleName,
    platform,
  );
};

// config.resolver.unstable_enablePackageExports = false;

module.exports = config;
