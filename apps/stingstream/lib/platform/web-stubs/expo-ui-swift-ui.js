/**
 * Web stub for `@expo/ui/swift-ui` and `@expo/ui/swift-ui/modifiers`
 * (StingStream M2 web target).
 *
 * `@expo/ui` is a SwiftUI bridge: its barrel calls
 * `requireNativeView("ExpoUI", ...)` at module scope, which throws under
 * react-native-web and blanks the page before React mounts.
 *
 * Three app components (`components/PlatformDropdown.tsx`,
 * `components/search/DiscoverFilters.tsx`,
 * `components/search/SearchTabButtons.tsx`) already load it lazily — but the
 * guard they use is `Platform.isTV`, which is *false* on web, so the require
 * still runs. Rather than edit those files (and risk changing the tvOS/iOS
 * behaviour the guard exists for), Metro substitutes this module for web only.
 *
 * Nothing here is ever rendered: every one of those components branches on
 * `Platform.OS === "ios"` before touching a SwiftUI element, so on web they
 * fall through to their React Native / bottom-sheet path. The stub only has to
 * survive being destructured.
 *
 * It is a Proxy so that any SwiftUI export the app starts using later
 * (`VStack`, `Picker`, `Switch`, a new modifier, …) keeps resolving instead of
 * producing an `undefined is not a component` crash: capitalised names come
 * back as null-rendering components, everything else as a no-op function.
 */

const componentCache = new Map();

const nullComponent = (name) => {
  if (!componentCache.has(name)) {
    const Component = () => null;
    Component.displayName = `ExpoUIWebStub(${name})`;
    componentCache.set(name, Component);
  }
  return componentCache.get(name);
};

/** Modifiers are called (`disabled(true)`) and their result only ever passed back in. */
const noopModifier = (name) => {
  const modifier = () => ({ $$expoUiWebStub: name });
  Object.defineProperty(modifier, "name", { value: name });
  return modifier;
};

module.exports = new Proxy(
  { __esModule: true },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== "string") return undefined;
      // React needs these to be absent, not stubs.
      if (prop === "default" || prop === "$$typeof" || prop === "then") {
        return undefined;
      }
      return /^[A-Z]/.test(prop) ? nullComponent(prop) : noopModifier(prop);
    },
    has() {
      return true;
    },
  },
);
