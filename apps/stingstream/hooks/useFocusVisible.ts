import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

/**
 * Whether the *keyboard* is what is moving focus around.
 *
 * `onFocus` fires on a mouse click too, so drawing the ring whenever a control
 * is focused puts a 2 px accent outline around whatever you last clicked — on
 * top of the fill and the accent bar that already say "this is the current
 * item". Three indicators for one state reads as a rendering bug, which is why
 * browsers grew `:focus-visible` in the first place.
 *
 * react-native-web has no way to express a pseudo-class, so the same rule is
 * kept here: a Tab or an arrow key turns the ring on for the whole app, the
 * next pointer press turns it off again. One listener, one boolean, published
 * through `useSyncExternalStore` so every focusable re-renders together.
 */

let keyboard = false;
const listeners = new Set<() => void>();

const publish = (next: boolean) => {
  if (next === keyboard) return;
  keyboard = next;
  for (const listener of listeners) listener();
};

if (Platform.OS === "web") {
  const target = globalThis as unknown as {
    addEventListener?: (
      type: string,
      handler: (event: { key?: string }) => void,
      capture?: boolean,
    ) => void;
  };
  // Capture phase: a control that stops propagation must not be able to hide
  // the fact that somebody is navigating by keyboard.
  target.addEventListener?.(
    "keydown",
    (event) => {
      const key = event.key ?? "";
      if (key === "Tab" || key.startsWith("Arrow")) publish(true);
    },
    true,
  );
  for (const event of ["mousedown", "pointerdown", "touchstart"]) {
    target.addEventListener?.(event, () => publish(false), true);
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const isKeyboardActive = () => keyboard;

/** `focused`, but only when focus arrived by keyboard. */
export const useFocusVisible = (focused: boolean): boolean => {
  const byKeyboard = useSyncExternalStore(
    subscribe,
    isKeyboardActive,
    isKeyboardActive,
  );
  return focused && byKeyboard;
};
