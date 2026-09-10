import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How long a field sits still before the change is sent.
 *
 * Long enough that typing a path or a server name is one save rather than one
 * per pause for thought, short enough that nobody has left the screen by the
 * time it fires. Leaving the screen saves immediately anyway — see the unmount
 * flush below — so this is only about how many requests a single edit costs.
 */
export const AUTOSAVE_DELAY = 1000;

/**
 * A settings draft that saves itself.
 *
 * **Settings pages have no Save button.** Dan: *"no save buttons in settings please unless its
 * SUPER critical change, but for 95% no save - changes are auto applied"*. A Save button on a
 * settings page is a trap with two halves: a change that looks made but is not, and a page that
 * quietly throws the change away when somebody navigates off it. Every pane here edited a whole
 * document and then asked for a click to send it, which is one more thing to forget on ten
 * different screens.
 *
 * What replaces it:
 *
 * - **A toggle saves at once.** Flipping a switch is the decision; there is nothing to debounce.
 *   Pass `{ now: true }`.
 * - **A text field saves when it stops changing**, `AUTOSAVE_DELAY` after the last keystroke, so a
 *   path is one request rather than forty.
 * - **Leaving the page flushes** whatever is still pending, because the alternative is losing an
 *   edit made a second before a back press.
 *
 * The caller keeps ownership of the request itself, including its success and failure toasts — the
 * documents here go to four different APIs and each has its own message. Anything `save` throws is
 * swallowed after that, since the caller has already reported it and an unhandled rejection helps
 * nobody.
 */
export function useAutosave<T>({
  value,
  save,
  delay = AUTOSAVE_DELAY,
}: {
  /** The saved truth: query data, or the value a parent passes down. */
  value: T | null | undefined;
  /** Sends one whole document. Reports its own failure. */
  save: (next: T) => Promise<unknown>;
  delay?: number;
}): {
  /** `null` until `value` first arrives, which is what a pane renders on. */
  draft: T | null;
  /** Edit the draft. `now` sends it immediately rather than after the pause. */
  set: (update: (current: T) => T, options?: { now?: boolean }) => void;
  /** A request is in flight. */
  saving: boolean;
} {
  const [draft, setDraft] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);

  // The draft the *edits* read, kept out of state on purpose: `set` has to build the next document
  // and hand it to the timer synchronously, and a state updater has not run yet at that point.
  const current = useRef<T | null>(null);
  const pending = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Seeded once, then owned by the form. Re-seeding on every refetch would throw away a half-typed
  // value the moment react-query revalidated — which, now that saving *causes* a revalidation, is
  // while the person is still typing.
  useEffect(() => {
    if (value != null && current.current == null) {
      current.current = value;
      setDraft(value);
    }
  }, [value]);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = pending.current;
    pending.current = null;
    if (next == null) return;

    if (mounted.current) setSaving(true);
    try {
      await saveRef.current(next);
    } catch {
      // The caller's `save` reports its own failure. This only stops the rejection escaping.
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, []);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(
    () => () => {
      mounted.current = false;
      void flushRef.current();
    },
    [],
  );

  const set = useCallback(
    (update: (c: T) => T, options?: { now?: boolean }) => {
      if (current.current == null) return;
      const next = update(current.current);
      current.current = next;
      pending.current = next;
      setDraft(next);

      if (options?.now) {
        void flushRef.current();
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flushRef.current(), delay);
    },
    [delay],
  );

  return { draft, set, saving };
}
