import { useFocusEffect } from "expo-router";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";

/**
 * What the top bar calls the page you are on.
 *
 * On web wide the tab-root headers are gone — the `TopBar` says where you are
 * instead — so a screen that wants a title other than its tab's label has to
 * hand one up. An atom rather than a context because the writer and the reader
 * are on opposite sides of the navigator: the screen is inside the `Stack`, the
 * top bar is outside it, and there is no provider between them that
 * `CLAUDE.test.ts` would let us add.
 *
 * Empty is the normal state. `TopBar` falls back to the active sidebar row's
 * label, which is right for every tab root, so only a deeper page (a library, a
 * settings sub-page) needs to set one.
 */
const screenTitleAtom = atom<string | null>(null);

/** Read side, for `TopBar`. */
export const useScreenTitle = (): string | null =>
  useAtomValue(screenTitleAtom);

/**
 * Write side, for a screen.
 *
 * Keyed on focus, not on mount: a `Stack` keeps the screens underneath the top
 * one mounted, so a title claimed at mount time would survive a push and a
 * title released at unmount would clear the one belonging to the screen the pop
 * returned to. React Navigation fires blur before focus, so the outgoing
 * screen's cleanup cannot overwrite the incoming screen's title.
 */
export const useSetScreenTitle = (title: string | null | undefined): void => {
  const setTitle = useSetAtom(screenTitleAtom);

  useFocusEffect(
    useCallback(() => {
      setTitle(title ?? null);
      return () => setTitle(null);
    }, [title, setTitle]),
  );
};
