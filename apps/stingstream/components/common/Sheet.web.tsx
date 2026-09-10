import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type ViewProps,
} from "react-native";
import { elevation, radius } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import type { SheetModalProps, SheetModalRef } from "./Sheet.types";

/**
 * The web half of the app's modal surface: a centred card with a scrim,
 * Escape and click-outside, in place of the bottom sheet a device gets.
 *
 * See `Sheet.tsx` for why both exist. Two things about this file matter:
 *
 * - The scrollables here are React Native's own, not `@gorhom/bottom-sheet`'s.
 *   Those throw outside a sheet, so there is no version of this that keeps
 *   them.
 * - `snapPoints`, `handleIndicatorStyle`, `backdropComponent` and the keyboard
 *   props are accepted and ignored. They describe a sheet being dragged, which
 *   is not a thing that happens with a pointer, and refusing them would mean
 *   every caller carrying a platform branch.
 */
export const SheetModal = forwardRef<SheetModalRef, SheetModalProps>(
  (
    {
      children,
      index,
      onChange,
      onDismiss,
      backgroundStyle,
      style,
      webMaxWidth = 560,
      webDismissible = true,
    },
    ref,
  ) => {
    const { color } = useTheme();
    const [visible, setVisible] = useState(false);
    // The open/closed state is also held in a ref so `present` and `dismiss`
    // can read it without a state updater running the caller's `onChange`
    // twice, which is what a side effect inside `setState` costs in StrictMode.
    const visibleRef = useRef(false);
    const { width } = useBreakpoint();

    const dismiss = useCallback(() => {
      if (!visibleRef.current) return;
      visibleRef.current = false;
      setVisible(false);
      onChange?.(-1);
      onDismiss?.();
    }, [onChange, onDismiss]);

    useImperativeHandle(
      ref,
      () => ({
        present: () => {
          if (visibleRef.current) return;
          visibleRef.current = true;
          setVisible(true);
          onChange?.(index ?? 0);
        },
        dismiss,
        close: dismiss,
      }),
      [dismiss, onChange, index],
    );

    // Escape closes, the way every other dialog on the web does.
    useEffect(() => {
      if (!visible || !webDismissible) return;
      const onKeyDown = (event: { key?: string }) => {
        if (event.key === "Escape") dismiss();
      };
      const target = globalThis as unknown as {
        addEventListener?: (t: string, h: (e: never) => void) => void;
        removeEventListener?: (t: string, h: (e: never) => void) => void;
      };
      target.addEventListener?.("keydown", onKeyDown as (e: never) => void);
      return () =>
        target.removeEventListener?.(
          "keydown",
          onKeyDown as (e: never) => void,
        );
    }, [visible, webDismissible, dismiss]);

    if (!visible) return null;

    return (
      <Modal
        visible
        transparent
        animationType='fade'
        onRequestClose={webDismissible ? dismiss : undefined}
        statusBarTranslucent
      >
        <Pressable
          accessibilityRole='button'
          accessibilityLabel='Close'
          onPress={webDismissible ? dismiss : undefined}
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            backgroundColor: color.scrim,
          }}
        >
          {/* A Pressable inside a Pressable: the card swallows the press so a
              click on the modal itself does not count as a click outside. */}
          <Pressable
            onPress={() => {}}
            style={[
              {
                width: "100%",
                maxWidth: Math.min(webMaxWidth, width - 48),
                maxHeight: "85%",
                borderRadius: radius.lg,
                borderWidth: 1,
                borderColor: color.border.subtle,
                backgroundColor: color.bg["1"],
                overflow: "hidden",
              },
              backgroundStyle,
              elevation(2),
              style,
            ]}
          >
            {children}
          </Pressable>
        </Pressable>
      </Modal>
    );
  },
);
SheetModal.displayName = "SheetModal";

/**
 * The sheet's content box.
 *
 * `flex: 1` is dropped on the way through, and that is the whole point of the
 * wrapper. A sheet on a device has a height, so its content growing to fill it
 * is right; the web card has none until its content gives it one, and a child
 * with `flex: 1` in an auto-height parent resolves to a basis of zero — an
 * empty card with a border. `flexShrink` is kept so long content still hits the
 * card's ceiling and scrolls instead of running off the screen.
 */
export const SheetView: React.FC<ViewProps> = ({ style, ...props }) => {
  const {
    flex: _flex,
    flexGrow: _flexGrow,
    flexBasis: _flexBasis,
    ...rest
  } = StyleSheet.flatten(style) ?? {};
  return <View {...props} style={[rest, { flexShrink: 1 }]} />;
};
export const SheetScrollView = ScrollView;
export const SheetFlatList = FlatList;
export const SheetTextInput = TextInput;

/** No scrim of its own: the card draws one. Kept so callers need no branch. */
export const SheetBackdrop: React.FC<Record<string, unknown>> = () => null;
export type SheetBackdropProps = Record<string, unknown>;

export type { SheetModalProps, SheetModalRef } from "./Sheet.types";
