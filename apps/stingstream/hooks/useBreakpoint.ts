import { useSyncExternalStore } from "react";
import { Dimensions, Platform } from "react-native";
import { type BreakpointName, breakpoints, gutter } from "@/constants/theme";

export interface Breakpoint {
  /** `compact` < 768 <= `medium` < 1280 <= `expanded`. */
  name: BreakpointName;
  /** The window width the name was derived from, in dp. */
  width: number;
  isCompact: boolean;
  isMedium: boolean;
  isExpanded: boolean;
  /**
   * The one flag that means "draw the desktop layout": a browser window at
   * least 768 dp wide. Deliberately narrower than "not compact" — a tablet and
   * a television are both `medium`/`expanded`, but neither gets the sidebar
   * shell, a hover state or a keyboard focus ring.
   */
  isWebWide: boolean;
  /** Page padding at this width: 16 / 24 / 32. */
  gutter: number;
}

/** The `medium` and `expanded` floors, as the token JSON declares them. */
export const BREAKPOINT_WIDTHS = breakpoints;

/** Pure: the width -> name rule, so a caller with a measured width can reuse it. */
export const breakpointFor = (width: number): BreakpointName => {
  if (width >= breakpoints.expanded) return "expanded";
  if (width >= breakpoints.medium) return "medium";
  return "compact";
};

/** Pure: the page padding for a breakpoint. */
export const gutterFor = (name: BreakpointName): number => gutter[name];

// ---------------------------------------------------------------------------
// One window listener for the whole app
// ---------------------------------------------------------------------------
//
// `useWindowDimensions()` registers its own `Dimensions` listener per call, and
// `Text` — which reads the breakpoint to size itself — renders hundreds of
// times on a busy screen. So the window is read once here and published to
// every subscriber through `useSyncExternalStore`, which is also what lets
// `useBreakpointName()` re-render only when the *band* changes rather than on
// every pixel of a drag-resize.

const listeners = new Set<() => void>();

let width = Dimensions.get("window").width;
// A television reports something like 960 dp (1920x1080 at 2x) and is always
// given the widest layout: a 10-foot UI is the most spacious one we have, not
// the middle one.
let name: BreakpointName = Platform.isTV ? "expanded" : breakpointFor(width);

Dimensions.addEventListener("change", ({ window }) => {
  if (window.width === width) return;
  width = window.width;
  name = Platform.isTV ? "expanded" : breakpointFor(width);
  for (const listener of listeners) listener();
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getWidth = () => width;
const getName = () => name;

/**
 * Just the band, for the many small components that only need to pick a size.
 *
 * Returns a string, so React bails out of the re-render unless the window
 * actually crossed 768 or 1280.
 */
export const useBreakpointName = (): BreakpointName =>
  useSyncExternalStore(subscribe, getName, getName);

/**
 * The app's one source of "how wide are we".
 *
 * Everything responsive reads this rather than a module-scope
 * `Dimensions.get()`, which never changes again after the first import — on web
 * that is a resize, on a phone a rotation, on a foldable an unfold.
 */
export const useBreakpoint = (): Breakpoint => {
  const currentWidth = useSyncExternalStore(subscribe, getWidth, getWidth);
  const currentName = useSyncExternalStore(subscribe, getName, getName);
  const isCompact = currentName === "compact";

  return {
    name: currentName,
    width: currentWidth,
    isCompact,
    isMedium: currentName === "medium",
    isExpanded: currentName === "expanded",
    isWebWide: Platform.OS === "web" && !Platform.isTV && !isCompact,
    gutter: gutterFor(currentName),
  };
};
