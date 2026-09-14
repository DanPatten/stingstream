import { useCallback, useEffect, useRef, useState } from "react";
import { AUTOSAVE_IDLE_DELAY, Autosaver, registerAutosaver } from "./autosaver";

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
 * What replaces it follows the usual settings-page convention:
 *
 * - **A toggle saves at once.** Flipping a switch is the decision; there is nothing to wait for.
 *   Pass `{ now: true }`.
 * - **A text field saves when it is committed**: it loses focus or Enter is pressed. `TextFieldRow`
 *   does that for every pane through `commitAutosaves`. It used to save a second after each pause
 *   in typing, which on the server name was a request and a toast per hesitation. A field left
 *   focused still saves after `AUTOSAVE_IDLE_DELAY`.
 * - **Leaving the page flushes** whatever is still pending, because the alternative is losing an
 *   edit made a second before a back press.
 * - **Nothing the server already has is sent**, and saves go one at a time. See `Autosaver`.
 *
 * The caller keeps ownership of the request itself, including its success and failure toasts — the
 * documents here go to four different APIs and each has its own message. Anything `save` throws is
 * swallowed after that, since the caller has already reported it and an unhandled rejection helps
 * nobody.
 */
export function useAutosave<T>({
  value,
  save,
  delay = AUTOSAVE_IDLE_DELAY,
}: {
  /** The saved truth: query data, or the value a parent passes down. */
  value: T | null | undefined;
  /** Sends one whole document. Reports its own failure. */
  save: (next: T) => Promise<unknown>;
  delay?: number;
}): {
  /** `null` until `value` first arrives, which is what a pane renders on. */
  draft: T | null;
  /** Edit the draft. `now` sends it immediately rather than when the field is committed. */
  set: (update: (current: T) => T, options?: { now?: boolean }) => void;
  /** A request is in flight. */
  saving: boolean;
} {
  const [draft, setDraft] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);

  // The draft the *edits* read, kept out of state on purpose: `set` has to build the next document
  // and hand it on synchronously, and a state updater has not run yet at that point.
  const current = useRef<T | null>(null);
  const mounted = useRef(true);
  const saveRef = useRef(save);
  saveRef.current = save;

  const saver = useRef<Autosaver<T> | null>(null);
  if (saver.current == null) {
    saver.current = new Autosaver<T>(
      (next) => saveRef.current(next),
      (on) => {
        if (mounted.current) setSaving(on);
      },
      delay,
    );
  }

  // Seeded once, then owned by the form. Re-seeding on every refetch would throw away a half-typed
  // value the moment react-query revalidated — which, now that saving *causes* a revalidation, is
  // while the person is still typing.
  useEffect(() => {
    if (value != null && current.current == null) {
      current.current = value;
      saver.current?.seed(value);
      setDraft(value);
    }
  }, [value]);

  useEffect(() => {
    const s = saver.current as Autosaver<T>;
    const unregister = registerAutosaver(s as Autosaver<unknown>);
    return () => {
      mounted.current = false;
      unregister();
      void s.commit();
    };
  }, []);

  const set = useCallback(
    (update: (c: T) => T, options?: { now?: boolean }) => {
      if (current.current == null) return;
      const next = update(current.current);
      current.current = next;
      setDraft(next);
      saver.current?.edit(next, options);
    },
    [],
  );

  return { draft, set, saving };
}
