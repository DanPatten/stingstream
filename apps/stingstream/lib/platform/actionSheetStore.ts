import type { ActionSheetOptions } from "@expo/react-native-action-sheet";

/**
 * The one pending action sheet, for the web build of `@expo/react-native-action-sheet`.
 *
 * On a phone that package draws the platform's own sheet, which is right there. In a browser it
 * draws a drawer that slides up from the bottom of the window, which is a phone app in a browser
 * frame and nothing like the centred dialog every other modal on the web is. So the web bundle
 * swaps the package for `lib/platform/web-stubs/expo-react-native-action-sheet.tsx`, which puts
 * the request here, and `components/common/ActionSheetDialog.tsx` draws it with `Dialog`.
 *
 * Callers do not change: `showActionSheetWithOptions(options, callback)` still calls back with the
 * index that was chosen, and with `cancelButtonIndex` when the dialog is dismissed.
 *
 * No React in here, so it can be tested on its own.
 */

export interface ActionSheetRequest {
  options: ActionSheetOptions;
  callback: (index?: number) => void | Promise<void>;
}

export interface ActionSheetChoice {
  index: number;
  label: string;
  destructive: boolean;
  disabled: boolean;
}

/** Split the flat option list into the choices to stack and the cancel button, if there is one. */
export function toDialogItems(options: ActionSheetOptions): {
  choices: ActionSheetChoice[];
  cancel: { index: number; label: string } | null;
} {
  const destructive = new Set(
    options.destructiveButtonIndex == null
      ? []
      : Array.isArray(options.destructiveButtonIndex)
        ? options.destructiveButtonIndex
        : [options.destructiveButtonIndex],
  );
  const disabled = new Set(options.disabledButtonIndices ?? []);
  const cancelIndex = options.cancelButtonIndex;

  const choices = options.options.flatMap((label, index) =>
    index === cancelIndex
      ? []
      : [
          {
            index,
            label,
            destructive: destructive.has(index),
            disabled: disabled.has(index),
          },
        ],
  );
  const cancel =
    cancelIndex != null && options.options[cancelIndex] != null
      ? { index: cancelIndex, label: options.options[cancelIndex] }
      : null;
  return { choices, cancel };
}

export function createActionSheetStore() {
  let current: ActionSheetRequest | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  /** Close the open sheet and report `index` to whoever opened it. */
  const select = (index?: number) => {
    const request = current;
    if (!request) return;
    current = null;
    notify();
    void request.callback(index);
  };

  /** Dismissed without choosing: the same answer the native sheet gives, the cancel index. */
  const dismiss = () => select(current?.options.cancelButtonIndex);

  const show = (
    options: ActionSheetOptions,
    callback: ActionSheetRequest["callback"],
  ) => {
    // A second sheet replaces the first. The first caller still hears back, as a cancel, so a
    // promise it is holding (useItemActionSheet) does not wait forever.
    if (current) dismiss();
    current = { options, callback };
    notify();
  };

  return {
    show,
    select,
    dismiss,
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The page's one action sheet. */
export const actionSheetStore = createActionSheetStore();
