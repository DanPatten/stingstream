import { useCallback, useEffect } from "react";
import { useWindowDimensions } from "react-native";
import {
  SheetBackdrop,
  type SheetBackdropProps,
  SheetModal,
} from "@/components/common/Sheet";
import { SHEET_MAX_HEIGHT_RATIO } from "@/constants/Values";
import { useGlobalModal } from "@/providers/GlobalModalProvider";

/**
 * GlobalModal Component
 *
 * The one modal every `showModal()` caller in the app is presented through:
 * dropdowns, action sheets, pickers and the imperative `useDialog`. A bottom
 * sheet on a device, a centred card in a browser, because that is what
 * `SheetModal` is (see `components/common/Sheet.tsx`).
 *
 * Place this component at the root level of your app (in _layout.tsx)
 * after BottomSheetModalProvider.
 */
export const GlobalModal = () => {
  const { hideModal, modalState, modalRef, isVisible } = useGlobalModal();
  // Derived here rather than passed in by callers: this component re-renders on
  // rotation, so a sheet that is already open follows the new window height.
  const { height: windowHeight } = useWindowDimensions();
  const maxDynamicContentSize = windowHeight * SHEET_MAX_HEIGHT_RATIO;

  useEffect(() => {
    if (isVisible && modalState.content) {
      modalRef.current?.present();
    }
  }, [isVisible, modalState.content, modalRef]);

  const handleSheetChanges = useCallback(
    (index: number) => {
      if (index === -1) {
        hideModal();
      }
    },
    [hideModal],
  );

  const renderBackdrop = useCallback(
    (props: SheetBackdropProps) => (
      <SheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  const defaultOptions = {
    enableDynamicSizing: true,
    enablePanDownToClose: true,
    backgroundStyle: {
      backgroundColor: "#171717",
    },
    handleIndicatorStyle: {
      backgroundColor: "white",
    },
  };

  // Merge default options with provided options
  const modalOptions = { ...defaultOptions, ...modalState.options };

  return (
    <SheetModal
      ref={modalRef}
      {...(modalOptions.snapPoints
        ? // Dynamic sizing is on by default and would add a content-height
          // detent next to the requested snap points, so turn it off for
          // callers that ask for fixed heights.
          { snapPoints: modalOptions.snapPoints, enableDynamicSizing: false }
        : {
            enableDynamicSizing: modalOptions.enableDynamicSizing,
            maxDynamicContentSize,
          })}
      onChange={handleSheetChanges}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={modalOptions.handleIndicatorStyle}
      backgroundStyle={modalOptions.backgroundStyle}
      enablePanDownToClose={modalOptions.enablePanDownToClose}
      enableDismissOnClose
      // Left at gorhom's defaults on purpose. `adjustResize` only means
      // something when the window actually resizes for the keyboard, and this
      // app draws edge to edge, so it never does — setting it drove the sheet
      // down behind the keyboard instead. Sheets with inputs scroll their own
      // content out of the way (see CustomHeaderSheet).
      keyboardBlurBehavior='restore'
      stackBehavior='push'
      style={{ zIndex: 1000 }}
    >
      {modalState.content}
    </SheetModal>
  );
};
