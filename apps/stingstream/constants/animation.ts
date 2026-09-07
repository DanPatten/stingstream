import { Platform } from "react-native";

/**
 * What to pass as `useNativeDriver` to React Native's `Animated`.
 *
 * There is no native animated module in a browser, so asking for the native
 * driver on web gets a `console.warn` — once per page load, from the first
 * animation to run — and then falls back to the JS driver anyway:
 *
 *   Animated: `useNativeDriver` is not supported because the native animated
 *   module is missing. Falling back to JS-based animation.
 *
 * The animation still plays, so the warning is noise rather than a defect. But
 * "zero console warnings on every screen" is an acceptance gate for v0.2.0, and
 * a log line nobody can act on is exactly the kind of noise that hides the one
 * that matters. Asking for the driver only where it exists costs nothing: on
 * native it is still `true`.
 *
 * Reanimated is unaffected — it has its own web runtime and never warns.
 */
export const USE_NATIVE_DRIVER = Platform.OS !== "web";
