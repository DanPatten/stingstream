import { NativeWindStyleSheet } from "nativewind";

/**
 * Make NativeWind v2 resolve `className` to real styles in the browser.
 *
 * **Without this, every Tailwind class in the app is inert on web.** Measured,
 * not theorised: `<View className='mt-2 mb-4'>` on the settings screen reached
 * the DOM as `class="css-g5y9jx mt-2 mb-4"` with `margin-top: 0px` and
 * `margin-bottom: 0px`. Around a thousand call sites across `app/**` and
 * `components/**` were silently doing nothing, which is why screens built out
 * of classes looked unstyled at desktop widths while the token primitives —
 * which compute their styles in JS — looked right.
 *
 * The cause is an auto-detection in NativeWind's runtime
 * (`style-sheet/runtime.js`, the constructor):
 *
 * ```js
 * this.setOutput({
 *   web: typeof StyleSheet.create({ test: {} }).test !== "number" ? "css" : "native",
 *   default: "native",
 * });
 * ```
 *
 * React Native returns a numeric handle from `StyleSheet.create`;
 * react-native-web returns the object. So on web NativeWind concludes it is in
 * a CSS-capable environment, switches to `preprocessed` mode, and hands the
 * class names through untouched for a stylesheet to match — the mode meant for
 * a build that runs NativeWind's PostCSS plugin over a `global.css`.
 *
 * This app has no such build. It is `web.output: "single"` served by the
 * gateway (`docs/M2-web-spike.md` §7 explains why static rendering was ruled
 * out), bundled by plain Metro with no PostCSS step, so the stylesheet those
 * class names need is never generated and never linked. The classes are
 * decoration on the DOM node and nothing else.
 *
 * Forcing `native` output makes the web runtime do what the native one does:
 * resolve each class against the styles the babel plugin already compiled into
 * every module (`NativeWindStyleSheet.create(...)`, ~330 of them in the
 * bundle) and hand React Native for Web a plain style object. No CSS pipeline,
 * no build changes, and identical behaviour to the phone and TV builds.
 *
 * **It must run before the first render**, which is why it is a side-effecting
 * module imported ahead of `expo-router/entry` in `index.web.ts` rather than a
 * call inside a component: `prepare()` reads the flag every time a class is
 * resolved, and anything rendered before the flip would resolve to nothing.
 */
NativeWindStyleSheet.setOutput({ default: "native" });
