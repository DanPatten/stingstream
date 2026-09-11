/**
 * Mouse-driven OSD: move the pointer and the controls come back, hold still and they leave with
 * the cursor.
 *
 * A phone has a tap to summon controls and a television has a D-pad; a desktop browser has neither,
 * and a player whose controls only appear on click steals the click that should have paused it.
 * Hiding the cursor with the controls is the other half — a mouse arrow parked over a movie is the
 * single most obvious "this is a web page pretending to be a player" tell.
 *
 * Inert off the web, so the player's one `Controls.tsx` can call it unconditionally.
 */

import { useEffect, useRef } from "react";
import { Platform } from "react-native";

export interface WebPointerActivityOptions {
  /** Whether the controls are on screen right now. */
  showControls: boolean;
  /** Bring them back — called on any pointer movement. */
  onShow: () => void;
  /** Take them away again after `timeout` of stillness. */
  onHide: () => void;
  /** Idle milliseconds before hiding. */
  timeout: number;
  /** Suspended while a menu is open or the user is scrubbing. */
  disabled?: boolean;
}

const isWeb = Platform.OS === "web" && typeof document !== "undefined";

export const useWebPointerActivity = ({
  showControls,
  onShow,
  onHide,
  timeout,
  disabled = false,
}: WebPointerActivityOptions): void => {
  // The handlers are re-created on every render by their callers; holding them in refs keeps the
  // listener registered once for the life of the player instead of being torn down and re-added on
  // each mouse move, which is what would make the timer restart at the wrong moment.
  const onShowRef = useRef(onShow);
  const onHideRef = useRef(onHide);
  const showControlsRef = useRef(showControls);
  const disabledRef = useRef(disabled);

  onShowRef.current = onShow;
  onHideRef.current = onHide;
  showControlsRef.current = showControls;
  disabledRef.current = disabled;

  useEffect(() => {
    if (!isWeb) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const body = document.body;
    // Remembered rather than assumed to be "": a page-level style may own it, and restoring a
    // guess would quietly override whatever that was.
    const originalCursor = body.style.cursor;

    const hide = () => {
      if (disabledRef.current) return;
      body.style.cursor = "none";
      onHideRef.current();
    };

    const arm = () => {
      if (timer) clearTimeout(timer);
      if (disabledRef.current) return;
      timer = setTimeout(hide, timeout);
    };

    const activity = () => {
      body.style.cursor = originalCursor;
      if (!showControlsRef.current) onShowRef.current();
      arm();
    };

    document.addEventListener("mousemove", activity);
    document.addEventListener("mousedown", activity);
    arm();

    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("mousemove", activity);
      document.removeEventListener("mousedown", activity);
      // Leaving the player with a hidden cursor would hide it for the whole app.
      body.style.cursor = originalCursor;
    };
  }, [timeout]);
};
