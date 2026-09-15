import { type ReactNode, type RefObject, useEffect, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { Dialog } from "@/components/common/Dialog";
import { Icon, type IconName } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { elevation, radius } from "@/constants/theme";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useTheme } from "@/hooks/useTheme";

/** Between the trigger and the menu. */
const GAP = 4;
/** The closest the menu comes to the edge of the window. */
const EDGE = 8;

type Rect = { x: number; y: number; width: number; height: number };

export interface AnchoredMenuProps {
  visible: boolean;
  onClose: () => void;
  /** What the menu opens from. A plain `View` with `collapsable={false}` measures reliably. */
  anchorRef: RefObject<View | null>;
  /** Shown only on a device, where the menu is a bottom sheet and has room for one. */
  title?: string;
  /** Which edge of the trigger the menu lines up with. A "..." at the end of a row wants `end`. */
  align?: "start" | "end";
  minWidth?: number;
  maxWidth?: number;
  children: ReactNode;
}

/**
 * A menu that opens from the control that asked for it.
 *
 * Dan, 2026-09-14, pointing at Plex's library "...": a menu rather than a modal wherever a short
 * list of choices is all there is. Every overflow menu and picker used to open a centred card with a
 * title, which is a lot of ceremony for three lines and puts the choices a long way from the pointer
 * that asked for them.
 *
 * **A dropdown in a browser, the same `Dialog` bottom sheet on a device.** A phone has no pointer to
 * anchor to and a sheet is that platform's own menu at thumb reach, so only the web changes. Never on
 * TV, which has its own navigation-based menus (`docs/conventions/tv.md`).
 *
 * The web half is React Native's `Modal`, transparent and without a scrim, because that is what
 * react-native-web portals to the top of the document: an absolutely positioned view inside the page
 * would be clipped by the first scroller or rounded card above the trigger.
 */
export const AnchoredMenu: React.FC<AnchoredMenuProps> = (props) =>
  Platform.OS === "web" && !Platform.isTV ? (
    <WebMenu {...props} />
  ) : (
    <Dialog visible={props.visible} onClose={props.onClose} title={props.title}>
      <View style={{ marginHorizontal: -8 }}>{props.children}</View>
    </Dialog>
  );

const WebMenu: React.FC<AnchoredMenuProps> = ({
  visible,
  onClose,
  anchorRef,
  align = "end",
  minWidth = 200,
  maxWidth = 320,
  children,
}) => {
  const { color } = useTheme();
  const window = useWindowDimensions();
  const [rect, setRect] = useState<Rect | null>(null);
  const [menuHeight, setMenuHeight] = useState(0);

  // Measured on open and again when the window changes size, since the trigger moves with it.
  useEffect(() => {
    if (!visible) {
      setRect(null);
      setMenuHeight(0);
      return;
    }
    anchorRef.current?.measureInWindow((x, y, width, height) =>
      setRect({ x, y, width, height }),
    );
  }, [visible, anchorRef, window.width, window.height]);

  // Escape closes, the way every other menu on the web does.
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: { key?: string }) => {
      if (event.key === "Escape") onClose();
    };
    const target = globalThis as unknown as {
      addEventListener?: (t: string, h: (e: never) => void) => void;
      removeEventListener?: (t: string, h: (e: never) => void) => void;
    };
    target.addEventListener?.("keydown", onKeyDown as (e: never) => void);
    return () =>
      target.removeEventListener?.("keydown", onKeyDown as (e: never) => void);
  }, [visible, onClose]);

  if (!visible) return null;

  // Below the trigger, flipped above it when there is no room, and pinned inside the window when
  // there is room in neither direction.
  let top = 0;
  let horizontal: ViewStyle = {};
  if (rect) {
    const below = rect.y + rect.height + GAP;
    const above = rect.y - GAP - menuHeight;
    top =
      below + menuHeight <= window.height - EDGE
        ? below
        : above >= EDGE
          ? above
          : Math.max(EDGE, window.height - EDGE - menuHeight);
    horizontal =
      align === "end"
        ? { right: Math.max(EDGE, window.width - (rect.x + rect.width)) }
        : {
            left: Math.max(
              EDGE,
              Math.min(rect.x, window.width - EDGE - minWidth),
            ),
          };
  }

  return (
    <Modal visible transparent animationType='none' onRequestClose={onClose}>
      <Pressable
        accessibilityLabel='Close'
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      />
      <View
        accessibilityRole='menu'
        onLayout={(event) => setMenuHeight(event.nativeEvent.layout.height)}
        style={[
          {
            position: "absolute",
            top,
            ...horizontal,
            minWidth,
            maxWidth: Math.min(maxWidth, window.width - EDGE * 2),
            maxHeight: window.height - EDGE * 2,
            // Hidden for the one frame before its own height is known, so a menu that has to flip
            // never flashes below the trigger first.
            opacity: rect && menuHeight > 0 ? 1 : 0,
            paddingVertical: 6,
            borderRadius: radius.sm,
            borderWidth: 1,
            borderColor: color.border.subtle,
            backgroundColor: color.bg["2"],
            overflow: "hidden",
          },
          elevation(2, color),
        ]}
      >
        <ScrollView style={{ flexGrow: 0 }}>{children}</ScrollView>
      </View>
    </Modal>
  );
};

export interface MenuItemProps {
  label: string;
  /** Absent for a row whose `trailing` control does the work. */
  onPress?: () => void;
  icon?: IconName;
  /** A second line under the label, when the label alone is not enough. */
  description?: string;
  /** The chosen one of a set, or a setting that is on. Drawn as a check. */
  selected?: boolean;
  disabled?: boolean;
  trailing?: ReactNode;
  testID?: string;
}

/** One line of a menu. */
export const MenuItem: React.FC<MenuItemProps> = ({
  label,
  onPress,
  icon,
  description,
  selected,
  disabled = false,
  trailing,
  testID,
}) => {
  const { accent } = useTheme();
  const states = usePressableStates({ disabled });

  const body = (
    <>
      {icon ? (
        <Icon
          name={icon}
          size={18}
          tone='secondary'
          style={{ marginRight: 12 }}
        />
      ) : null}
      <View style={{ flex: 1 }}>
        <Text variant='body'>{label}</Text>
        {description ? (
          <Text variant='caption' tone='tertiary' style={{ marginTop: 2 }}>
            {description}
          </Text>
        ) : null}
      </View>
      {trailing}
      {selected ? (
        <Icon
          name='check'
          size={18}
          color={accent[500]}
          style={{ marginLeft: 12 }}
        />
      ) : null}
    </>
  );

  const box: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 40,
    paddingHorizontal: 16,
    paddingVertical: 8,
    opacity: disabled ? 0.5 : 1,
  };

  // A row holding a control of its own cannot also be a button: on web a Pressable is a real
  // `<button>`, and one inside another is invalid markup that swallows the inner press.
  if (!onPress) {
    return (
      <View testID={testID} style={box}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole='menuitem'
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      {...states.handlers}
      style={[
        box,
        { backgroundColor: states.overlay ?? "transparent" },
        states.webStyle,
      ]}
    >
      {body}
    </Pressable>
  );
};

/** A run of menu items, with an optional heading and a rule above it. */
export const MenuSection: React.FC<{
  title?: string;
  divider?: boolean;
  children: ReactNode;
}> = ({ title, divider = false, children }) => {
  const { color } = useTheme();
  return (
    <View>
      {divider ? (
        <View
          style={{
            height: StyleSheet.hairlineWidth,
            backgroundColor: color.border.subtle,
            marginVertical: 6,
          }}
        />
      ) : null}
      {title ? (
        <Text
          variant='caption'
          tone='tertiary'
          weight='medium'
          style={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: 2 }}
        >
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
};
