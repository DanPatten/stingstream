import {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetFlatList,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetTextInput,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import { forwardRef } from "react";
import type { SheetModalProps, SheetModalRef } from "./Sheet.types";

/**
 * The app's modal surface: a bottom sheet on a device, a centred card in a
 * browser (`Sheet.web.tsx`).
 *
 * Every modal used to be a `@gorhom/bottom-sheet` directly, which is the right
 * shape on a phone and the wrong one at 1440 px, where a panel sliding up from
 * the bottom edge of a monitor and spanning the whole window reads as a mobile
 * app someone has loaded in a browser. Routing them all through one component
 * is what makes that a single decision rather than eighteen of them.
 *
 * Import the `Sheet*` names, never `@gorhom/bottom-sheet` directly: the
 * package's scrollables throw outside a sheet ("'Scrollable' cannot be used out
 * of the BottomSheet!"), so a `BottomSheetScrollView` inside the web card is a
 * blank screen and a red box, not a layout nit.
 */
export const SheetModal = forwardRef<SheetModalRef, SheetModalProps>(
  (
    {
      children,
      webMaxWidth: _webMaxWidth,
      webDismissible: _webDismissible,
      ...props
    },
    ref,
  ) => (
    // `children` is required on BottomSheetModalProps but optional here, so it
    // is passed through explicitly rather than in the spread.
    <BottomSheetModal ref={ref as never} {...props}>
      {children}
    </BottomSheetModal>
  ),
);
SheetModal.displayName = "SheetModal";

export const SheetView = BottomSheetView;
export const SheetScrollView = BottomSheetScrollView;
export const SheetFlatList = BottomSheetFlatList;
export const SheetTextInput = BottomSheetTextInput;
export const SheetBackdrop = BottomSheetBackdrop;
export type SheetBackdropProps = BottomSheetBackdropProps;

export type { SheetModalProps, SheetModalRef } from "./Sheet.types";
