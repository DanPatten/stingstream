import { atom, useAtom } from "jotai";
import { useCallback } from "react";

/**
 * Whether the compact navigation drawer is open.
 *
 * An atom rather than component state because the two halves of the drawer sit
 * on opposite sides of the navigator: the button that opens it is in the bottom
 * tab bar, which the navigator renders, and the drawer itself is in the frame
 * *around* the navigator, where it can cover the bar it was opened from.
 */
export const navDrawerOpenAtom = atom(false);

export interface NavDrawer {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

export const useNavDrawer = (): NavDrawer => {
  const [open, setOpen] = useAtom(navDrawerOpenAtom);

  return {
    open,
    toggle: useCallback(() => setOpen((value) => !value), [setOpen]),
    close: useCallback(() => setOpen(false), [setOpen]),
  };
};
