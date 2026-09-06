import { describe, expect, mock, test } from "bun:test";
import { stubReactNative } from "@/test-utils/reactNative";

// Stub native/router modules — bun:test cannot load React Native, and only
// the pure route helpers are under test here.
stubReactNative({ isTV: true });
mock.module("expo-router", () => ({
  useSegments: () => [],
}));

const { TAB_ROUTES, isAtTabRoot, isTabRoute } = await import(
  "./useTVBackHandler"
);

describe("isAtTabRoot", () => {
  test("true at the root of a tab", () => {
    expect(isAtTabRoot(["(auth)", "(tabs)", "(home)"])).toBe(true);
    expect(isAtTabRoot(["(auth)", "(tabs)", "(settings)"])).toBe(true);
  });

  test("false on routes deeper than a tab root", () => {
    expect(isAtTabRoot(["(auth)", "(tabs)", "(home)", "items", "123"])).toBe(
      false,
    );
  });

  test("false on the tabs placeholder route (segments never contain 'index')", () => {
    // app/(auth)/(tabs)/index.tsx: expo-router pops a trailing "index"
    // segment, so the placeholder yields ["(auth)", "(tabs)"]. The navigator
    // immediately redirects to (home), so it is not treated as a tab root.
    expect(isAtTabRoot(["(auth)", "(tabs)"])).toBe(false);
  });

  test("false with no segments", () => {
    expect(isAtTabRoot([])).toBe(false);
  });
});

describe("isTabRoute", () => {
  test("matches tab group segments only", () => {
    expect(isTabRoute("(home)")).toBe(true);
    expect(isTabRoute("(tabs)")).toBe(false);
    expect(isTabRoute("index")).toBe(false);
  });
});

describe("TAB_ROUTES", () => {
  // Requests is a real tab on phone and TV. While it was missing from this
  // list, `useTVTabRootBackHandler` did not recognise the Requests root as a
  // tab root, so BACK there popped the Stack and left the tab navigator
  // instead of going Home.
  test("includes every tab group the navigator renders", () => {
    expect([...TAB_ROUTES].sort()).toEqual(
      [
        "(custom-links)",
        "(favorites)",
        "(home)",
        "(libraries)",
        "(requests)",
        "(search)",
        "(settings)",
        "(watchlists)",
      ].sort(),
    );
  });

  test("the Requests root is a tab root, so BACK there goes Home", () => {
    expect(isTabRoute("(requests)")).toBe(true);
    expect(isAtTabRoot(["(auth)", "(tabs)", "(requests)"])).toBe(true);
    expect(
      isAtTabRoot(["(auth)", "(tabs)", "(requests)", "details", "42"]),
    ).toBe(false);
  });
});
