/**
 * How long a field can sit still, still focused, before the change is sent anyway.
 *
 * It is a fallback, not the trigger. A text field saves when it is *committed*: it loses focus, or
 * Enter is pressed, or the page is left. Saving on a short pause instead sent a server name once
 * for every hesitation while it was being typed, each with its own "Saved" toast, which is the
 * editor reporting on the person rather than the other way round. The timer only exists for
 * somebody who types a value and then walks away from the machine with the cursor still in it.
 */
export const AUTOSAVE_IDLE_DELAY = 3000;

type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The scheduling half of `useAutosave`, kept free of React so it can be tested with a fake clock.
 *
 * Three rules beyond "send it later":
 *
 * - **Nothing is sent that the server already has.** A field typed into and changed back, or a
 *   field focused and left untouched, costs no request. Compared by value, since every edit builds
 *   a new object.
 * - **One request at a time.** A commit that arrives while a save is in flight waits for it and
 *   then sends only the newest document, so two saves can never land out of order and the older
 *   one win.
 * - **A failed save is not remembered as sent**, so committing the same value again retries it.
 */
export class Autosaver<T> {
  private saved: string | null = null;
  private pending: T | null = null;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly save: (next: T) => Promise<unknown>,
    private readonly onSavingChange: (saving: boolean) => void = () => {},
    private readonly delay = AUTOSAVE_IDLE_DELAY,
    private readonly timers: Timers = realTimers,
  ) {}

  /** The document as the server has it. Seeds the comparison, so an untouched field sends nothing. */
  seed(value: T) {
    this.saved = JSON.stringify(value);
  }

  /** Record an edit. `now` is a switch: the edit is the decision, so it is committed at once. */
  edit(next: T, options?: { now?: boolean }) {
    this.pending = next;
    this.clearTimer();
    if (options?.now) {
      void this.commit();
      return;
    }
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.commit();
    }, this.delay);
  }

  /** Send whatever is pending, if it differs from what the server has. */
  async commit(): Promise<void> {
    this.clearTimer();
    // Wait out a save already on its way. The loop, because another commit may have started one
    // while this one was waiting.
    while (this.inFlight) await this.inFlight;

    const next = this.pending;
    this.pending = null;
    if (next == null) return;
    const serialised = JSON.stringify(next);
    if (serialised === this.saved) return;

    this.inFlight = this.send(next, serialised);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async send(next: T, serialised: string) {
    this.onSavingChange(true);
    try {
      await this.save(next);
      this.saved = serialised;
    } catch {
      // The caller's `save` reports its own failure. This only stops the rejection escaping.
    } finally {
      this.onSavingChange(false);
    }
  }

  private clearTimer() {
    if (this.timer != null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Every autosaving draft on screen, so a text field can commit without being told which one it
 * belongs to. `TextFieldRow` is used by a dozen panes, and threading a `commit` through each of
 * them would be a dozen places to forget it. Committing a draft with nothing pending is free, so
 * committing all of them on blur is exact.
 */
const live = new Set<Autosaver<unknown>>();

export function registerAutosaver(saver: Autosaver<unknown>): () => void {
  live.add(saver);
  return () => live.delete(saver);
}

/** A field was committed: blurred, or Enter pressed. */
export function commitAutosaves(): void {
  for (const saver of live) void saver.commit();
}
