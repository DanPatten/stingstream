import { useCallback, useEffect, useState } from "react";
import type { PickableLibrary } from "./LibraryPicker";

/**
 * The libraries a *new* share starts with: all of them, ticked.
 *
 * Dan: *"default sharing screen by checking both Movies and TV shows (or any other libraires that
 * exist (user will uncheck if they want))"*. Sharing everything is what almost every invite means,
 * and starting from nothing made the common case a chore and the empty-picker refusal a thing
 * people met on their way to the obvious answer.
 *
 * **This is a UI default, not a server one.** A link with no choice recorded still shares nothing
 * (`SharedLibraryStore`) — which is what protects a link created by anything other than these two
 * screens. What changed is where the form starts, and the person is looking at the ticks while
 * they decide.
 *
 * **Seeded once.** `null` means "not seeded yet"; an empty array means "seeded, and they unticked
 * everything". Without that distinction, unticking the last library would re-tick them all on the
 * next render, which reads as the screen fighting you.
 *
 * Only for creating a share. A picker that shows what is *already* stored — `GroupDetailScreen`'s —
 * must show the truth, and pre-ticking there would claim access nobody granted.
 */
export function useChosenLibraries(available: PickableLibrary[]) {
  const [chosen, setChosen] = useState<string[] | null>(null);

  useEffect(() => {
    if (chosen !== null || available.length === 0) return;
    setChosen(available.map((library) => library.id));
  }, [available, chosen]);

  const toggle = useCallback((id: string) => {
    setChosen((current) => {
      const now = current ?? [];
      return now.includes(id)
        ? now.filter((existing) => existing !== id)
        : [...now, id];
    });
  }, []);

  /** Back to unseeded, so the next time the form opens it starts from all of them again. */
  const reset = useCallback(() => setChosen(null), []);

  return { chosen: chosen ?? [], toggle, reset };
}
