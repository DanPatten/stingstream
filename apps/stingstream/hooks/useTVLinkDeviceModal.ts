import { useCallback } from "react";
import useRouter from "@/hooks/useAppRouter";
import {
  type TVLinkDeviceModalState,
  tvLinkDeviceModalAtom,
} from "@/utils/atoms/tvLinkDeviceModal";
import { store } from "@/utils/store";

/**
 * Opens the "Link a device" modal.
 *
 * `store.set` rather than a `useSetAtom` setter: the write has to land before
 * the navigation, and a React state update scheduled in the same tick does
 * not — the route would mount against a null atom. Every other TV modal hook
 * in this codebase does the same for the same reason.
 */
export function useTVLinkDeviceModal() {
  const router = useRouter();

  const showLinkDeviceModal = useCallback(
    (state: NonNullable<TVLinkDeviceModalState> = {}) => {
      store.set(tvLinkDeviceModalAtom, state);
      router.push("/(auth)/tv-link-device-modal");
    },
    [router],
  );

  return { showLinkDeviceModal };
}
