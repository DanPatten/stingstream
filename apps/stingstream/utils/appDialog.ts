/**
 * "Are you sure?", asked the same way on every platform this app ships to.
 *
 * ## Why this exists
 *
 * Dan: *"NEVER use browser's alert function - replace them with proper modals"*.
 *
 * There were two wrong answers in the codebase and this replaces both:
 *
 * - **`globalThis.confirm`** — the browser's own dialog. It cannot be styled, it says the page's
 *   hostname above the question, it blocks the JS thread, and some browsers let a user suppress it
 *   permanently, which silently turns every later confirmation into an automatic "no".
 * - **`Alert.alert` on the web** — react-native-web draws *nothing at all* for it. Not a fallback,
 *   not a warning. A destructive action guarded by one on the web bundle simply does nothing when
 *   pressed: the guard is gone and so is the action.
 *
 * So a confirmation is a React component now, rendered through the app's own `Dialog` — a card in
 * a browser, a sheet on a phone. `Alert.alert` survives in exactly one place, television, where it
 * is a real native control and where `docs/conventions/tv.md` forbids the overlay kind of modal.
 *
 * ## Shape
 *
 * A module-level store rather than a hook, because the callers are event handlers in the middle of
 * an async function — `const ok = await confirmDestructive(...)` — and a hook cannot be awaited.
 * `AppDialogHost` renders whatever is in here; this file never imports React.
 */

export interface ConfirmRequest {
  /** Bumped per request so the host re-renders even for two identical questions in a row. */
  id: number;
  title: string;
  message?: string;
  confirmLabel?: string;
  /** Draws the confirm button in danger red. */
  destructive: boolean;
  resolve: (confirmed: boolean) => void;
}

let current: ConfirmRequest | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export const subscribeAppDialog = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The open request, or `null`. Identity only changes when the request does. */
export const getAppDialog = (): ConfirmRequest | null => current;

/**
 * Ask the question. Resolves `true` only if the person actually confirmed.
 *
 * A second question while one is open resolves `false` rather than stacking two dialogs: two
 * overlapping confirmations is a way to agree to the wrong one.
 */
export const requestConfirm = (options: {
  title: string;
  message?: string;
  confirmLabel?: string;
  destructive?: boolean;
}): Promise<boolean> => {
  if (current) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    current = {
      id: nextId++,
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel,
      destructive: options.destructive ?? false,
      resolve,
    };
    emit();
  });
};

/** Answer and close. Called by the host; safe to call when nothing is open. */
export const settleAppDialog = (confirmed: boolean) => {
  const request = current;
  if (!request) return;
  current = null;
  emit();
  request.resolve(confirmed);
};

/**
 * Drop an open question without answering it, for a sign-out or a teardown.
 *
 * Resolves `false`, because an unanswered "are you sure?" is a no.
 */
export const resetAppDialog = () => settleAppDialog(false);
