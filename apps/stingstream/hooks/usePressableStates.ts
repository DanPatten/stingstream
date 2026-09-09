import { useCallback, useMemo, useState } from "react";
import { Platform, type ViewStyle } from "react-native";
import {
  type AccentName,
  DEFAULT_ACCENT,
  interaction,
  motion,
  rgba,
  webFocusRing,
} from "@/constants/theme";
import { useFocusVisible } from "./useFocusVisible";
import { useTheme } from "./useTheme";

/** Precedence, most specific first: a disabled control is never "hovered". */
export type InteractionState = "disabled" | "pressed" | "hovered" | "rest";

export interface PressableStateHandlers {
  onPressIn: () => void;
  onPressOut: () => void;
  onHoverIn: () => void;
  onHoverOut: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

export interface PressableStates {
  /** Raw flags, for a control that draws something other than an overlay. */
  hovered: boolean;
  pressed: boolean;
  /**
   * Keyboard/D-pad focus, as the platform reports it. On TV this is what drives the ring and the
   * scale. On web it is true after a mouse click too, so draw from `webStyle` rather than from
   * this — see `useFocusVisible`.
   */
  focused: boolean;
  disabled: boolean;
  /** The four states collapsed in precedence order. */
  state: InteractionState;
  /** Spread onto the `Pressable`. */
  handlers: PressableStateHandlers;
  /**
   * A white wash to lay over the control's own surface: `undefined` at rest,
   * so a caller can skip the extra view entirely. Use it when the surface is
   * an image or a gradient and there is no flat colour to lighten.
   */
  overlay: string | undefined;
  /**
   * Cursor, transition and the keyboard focus ring — web only, `{}` elsewhere.
   * Spread it into the control's own style.
   */
  webStyle: ViewStyle;
}

export interface PressableStatesOptions {
  disabled?: boolean;
  /**
   * Draw the focus ring even when the control is disabled. Off by default: a
   * control that cannot be actuated should not advertise itself to the
   * keyboard.
   */
  focusRingWhenDisabled?: boolean;
  /** Override the accent the ring is drawn in. Defaults to the user's. */
  accent?: AccentName;
}

/**
 * Hover, pressed, keyboard focus and disabled, in one place.
 *
 * Every interactive surface in the app needs the same four states and kept
 * growing its own slightly different version of them: the button had hover but
 * no pressed tint, list rows had hover and nothing else, and cards had none at
 * all — so a mouse crossing the page lit up some things and not others, which
 * reads as half the UI being decoration.
 *
 * Two rules are baked in rather than left to the caller:
 *
 *  - **`onHoverIn` never fires on a touch device**, so `hovered` is genuinely
 *    "a pointer is over this" — but a phone browser can still fire it from a
 *    tap, which is why `pressed` outranks `hovered` in `state`.
 *  - **Disabled outranks everything.** A `Pressable` with `disabled` set stops
 *    firing press events but keeps firing hover ones on web, so without the
 *    precedence a disabled button still lit up under the cursor.
 *
 * The focus ring is web-only on purpose: TV focus is the white ring and scale
 * described in `docs/conventions/tv.md`, never an accent outline, and touch
 * platforms have no keyboard focus to show.
 */
export const usePressableStates = (
  options: PressableStatesOptions = {},
): PressableStates => {
  const { disabled = false, focusRingWhenDisabled = false, accent } = options;
  const { accentName } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focused, setFocused] = useState(false);
  /**
   * Focus worth drawing: focus that arrived from the keyboard.
   *
   * `onFocus` fires on a mouse click too, so the ring used to appear around whatever you last
   * clicked -- Dan, on a minted invite: *"button borders are fucked up"*. The tokens have always
   * called this the *keyboard* focus ring, and a 2 px accent outline a pixel outside a `secondary`
   * button's own border reads as a rendering fault rather than as focus.
   *
   * `useFocusVisible` is the app's existing answer, written for the sidebar and moved into `hooks/`
   * when this needed it: one listener, published through `useSyncExternalStore`, so a Tab lights
   * the control that already had focus rather than only the next one.
   */
  const focusVisible = useFocusVisible(focused);

  const onPressIn = useCallback(() => setPressed(true), []);
  const onPressOut = useCallback(() => setPressed(false), []);
  const onHoverIn = useCallback(() => setHovered(true), []);
  const onHoverOut = useCallback(() => setHovered(false), []);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);

  const handlers = useMemo(
    () => ({
      onPressIn,
      onPressOut,
      onHoverIn,
      onHoverOut,
      onFocus,
      onBlur,
    }),
    [onPressIn, onPressOut, onHoverIn, onHoverOut, onFocus, onBlur],
  );

  const state: InteractionState = disabled
    ? "disabled"
    : pressed
      ? "pressed"
      : hovered
        ? "hovered"
        : "rest";

  const overlay = overlayFor(state);

  const webStyle: ViewStyle =
    Platform.OS === "web"
      ? ({
          cursor: disabled ? "not-allowed" : "pointer",
          // Web-only and ignored by the native renderers, so it is safe to
          // leave in the shared style object.
          transitionDuration: `${motion.fast}ms`,
          ...webFocusRing(
            focusVisible && (!disabled || focusRingWhenDisabled),
            accent ?? accentName ?? DEFAULT_ACCENT,
          ),
        } as ViewStyle)
      : {};

  return {
    hovered: hovered && !disabled,
    pressed: pressed && !disabled,
    focused,
    disabled,
    state,
    handlers,
    overlay,
    webStyle,
  };
};

/** The white wash for a state, or `undefined` at rest and when disabled. */
export const overlayFor = (state: InteractionState): string | undefined => {
  if (state === "hovered") {
    return rgba("#FFFFFF", interaction.hoverOverlay);
  }
  if (state === "pressed") {
    return rgba("#FFFFFF", interaction.pressedOverlay);
  }
  return undefined;
};
