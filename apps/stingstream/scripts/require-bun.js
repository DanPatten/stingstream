#!/usr/bin/env node
// Guard run as this package's "preinstall" script.
//
// apps/stingstream must be installed with bun, not npm or yarn: yarn's hoisting puts a second
// copy of react-native-screens under expo-router/node_modules (package.json pins the top-level
// version deliberately -- see "expo.install.exclude" -- and yarn's hoister does not respect that),
// and the Android / Android TV app then crashes at startup with "Tried to register two views with
// the same name RNSScreen". `expo export --platform android` succeeds happily on the broken tree,
// so no bundler check catches this -- only a real device/emulator run does. See
// docs/M2-web-spike.md section 8 and docs/APP-DEV.md ("Why not yarn/npm").
//
// npm, yarn and bun all set npm_config_user_agent for scripts they run, and only bun's starts
// with "bun/" -- confirmed empirically against bun 1.4.1, yarn 1.22.22 and npm 11.6.1. An absent
// or unrecognized user agent fails closed (blocks the install) rather than silently allowing it.
const userAgent = process.env.npm_config_user_agent || "";

if (!/^bun\//.test(userAgent)) {
  console.error(
    [
      "",
      "ERROR: apps/stingstream must be installed with bun, not npm or yarn.",
      `  Detected package manager user agent: ${userAgent || "(none)"}`,
      "",
      "  Run instead:",
      "    bun install --frozen-lockfile",
      "",
      "  See docs/APP-DEV.md for setup instructions and why yarn/npm are refused",
      "  (a duplicate react-native-screens copy that crashes the app at startup).",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
