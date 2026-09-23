/**
 * Escape closes the top modal on the web, and only the top one.
 *
 * `Dialog` and the web `SheetModal` each used to add their own `keydown` listener to the window,
 * so a sheet opened from inside a dialog (the folder browser inside Add library) closed both on one
 * Escape and threw the dialog's form away. Each open modal now pushes its handler here, and the one
 * listener calls only the most recent.
 *
 * No React and no react-native, so `bun:test` can load it.
 */

type Handler = () => void;

const stack: { handler: Handler }[] = [];

let listening = false;

const target = globalThis as unknown as {
  addEventListener?: (type: string, h: (e: { key?: string }) => void) => void;
  removeEventListener?: (
    type: string,
    h: (e: { key?: string }) => void,
  ) => void;
};

/** What the window listener does with one key press. Exported for the test. */
export function handleEscapeKey(key: string | undefined): boolean {
  if (key !== "Escape") return false;
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.handler();
  return true;
}

const onKeyDown = (event: { key?: string }) => {
  handleEscapeKey(event.key);
};

/** Register a modal's Escape handler. Call the result when the modal closes. */
export function pushEscape(handler: Handler): () => void {
  const entry = { handler };
  stack.push(entry);
  if (!listening) {
    target.addEventListener?.("keydown", onKeyDown);
    listening = true;
  }
  return () => {
    const index = stack.lastIndexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    if (stack.length === 0 && listening) {
      target.removeEventListener?.("keydown", onKeyDown);
      listening = false;
    }
  };
}
