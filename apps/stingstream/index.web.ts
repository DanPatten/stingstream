/**
 * Web entry point (StingStream M2 web target).
 *
 * Metro resolves the package `main` (`./index`) with platform extensions, so
 * this file replaces `index.ts` for `platform === "web"` and the native entry
 * is left exactly as it was.
 *
 * Two differences from `index.ts`:
 *   1. Browser polyfills load first — see `lib/platform/web-polyfills.ts`.
 *   2. `react-native-track-player`'s playback service is never registered.
 *      Registering a background audio service is meaningless in a tab, and the
 *      module is stubbed on web anyway (`metro.config.js` → `webModuleStubs`).
 */

import "./lib/platform/web-polyfills";
import "react-native-url-polyfill/auto";
import "@expo/metro-runtime";
import "expo-router/entry";
