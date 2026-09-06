import { atom } from "jotai";

export type TVLinkDeviceModalState = {
  /** Shown under the title so the viewer knows which server they are linking to. */
  serverName?: string;
} | null;

/**
 * State for the "Link a device" route modal.
 *
 * A TV modal is a route plus an atom, never an overlay — see
 * `docs/tv-modal-guide.md` and the learned fact
 * `tv-modals-must-use-navigation-pattern`. The atom carries what the route
 * cannot get from params without stringifying it.
 */
export const tvLinkDeviceModalAtom = atom<TVLinkDeviceModalState>(null);
