/**
 * The browser Fullscreen API, behind four functions that are safe to call anywhere.
 *
 * Every entry point is a no-op off the web, so the player's controls can call them unguarded on
 * all three platforms — the alternative is a `Platform.OS === "web"` at every call site, which is
 * how one of them eventually gets forgotten and crashes a phone build on `document`.
 *
 * The vendor-prefixed spellings are still here because Safari (including every iPad browser, which
 * is Safari) never shipped the unprefixed names for the element methods.
 */

import { Platform } from "react-native";

const isWeb = Platform.OS === "web" && typeof document !== "undefined";

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

const doc = (): FullscreenDocument | null =>
  isWeb ? (document as FullscreenDocument) : null;

/** Whether anything on the page is currently fullscreen. */
export const isFullscreen = (): boolean => {
  const d = doc();
  if (!d) return false;
  return Boolean(d.fullscreenElement ?? d.webkitFullscreenElement);
};

/**
 * Ask for fullscreen on `element`, or leave it if the page is already fullscreen.
 *
 * Rejections are swallowed: `requestFullscreen` rejects when it was not called from a user
 * gesture, and an unhandled rejection in a keydown handler is a console error the sweep would
 * (rightly) flag. The button simply does nothing, which is what the browser decided anyway.
 */
export const toggleFullscreen = async (
  element: HTMLElement | null | undefined,
): Promise<void> => {
  const d = doc();
  if (!d) return;

  try {
    if (isFullscreen()) {
      await (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
      return;
    }
    const target = (element ?? d.documentElement) as FullscreenElement;
    await (target.requestFullscreen?.() ?? target.webkitRequestFullscreen?.());
  } catch {
    // Denied by the browser (no user gesture, or an embed policy). Nothing to recover.
  }
};

/** Leave fullscreen if we are in it. Safe to call when we are not. */
export const exitFullscreen = async (): Promise<void> => {
  const d = doc();
  if (!d || !isFullscreen()) return;
  try {
    await (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
  } catch {
    // Already leaving, or never entered.
  }
};

/**
 * Subscribe to fullscreen changes, returning an unsubscribe.
 *
 * Needed because the state can change without the app asking: F11, Escape, and the browser's own
 * exit button all fire this and nothing else, so a button that only tracked its own presses would
 * show the wrong icon for the rest of the session.
 */
export const onFullscreenChange = (
  listener: (fullscreen: boolean) => void,
): (() => void) => {
  const d = doc();
  if (!d) return () => {};

  const handler = () => listener(isFullscreen());
  d.addEventListener("fullscreenchange", handler);
  d.addEventListener("webkitfullscreenchange", handler);
  return () => {
    d.removeEventListener("fullscreenchange", handler);
    d.removeEventListener("webkitfullscreenchange", handler);
  };
};
