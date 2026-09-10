import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";

/**
 * The imperative handle a sheet exposes. A subset of `BottomSheetModal`'s:
 * these are the methods the app actually calls, and the web card can honour
 * every one of them.
 */
export interface SheetModalRef {
  present: () => void;
  dismiss: () => void;
  close: () => void;
}

/** Props shared by the native sheet and the web card. */
export interface SheetModalProps {
  children?: ReactNode;
  /** Native only. The web card sizes itself to its content. */
  snapPoints?: (string | number)[];
  index?: number;
  enableDynamicSizing?: boolean;
  maxDynamicContentSize?: number;
  enablePanDownToClose?: boolean;
  enableDismissOnClose?: boolean;
  onChange?: (index: number) => void;
  onDismiss?: () => void;
  /** Native only. The web card draws its own scrim. */
  backdropComponent?: React.FC<any>;
  /** The sheet's own surface. On the web this is the card. */
  backgroundStyle?: StyleProp<ViewStyle>;
  /** Native only. There is no drag handle on a pointer. */
  handleIndicatorStyle?: StyleProp<ViewStyle>;
  keyboardBehavior?: "extend" | "fillParent" | "interactive";
  keyboardBlurBehavior?: "none" | "restore";
  android_keyboardInputMode?: "adjustPan" | "adjustResize";
  topInset?: number;
  bottomInset?: number;
  stackBehavior?: "push" | "replace" | "switch";
  style?: StyleProp<ViewStyle>;
  /** Web only. The card's ceiling, in dp. Defaults to 560. */
  webMaxWidth?: number;
  /**
   * Web only. `false` for a question that has to be answered: no Escape, no
   * click outside. The native sheet expresses the same thing through its
   * backdrop, so this has no effect off the web.
   */
  webDismissible?: boolean;
}
