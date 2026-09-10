import {
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useEffect,
} from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { Button, type ButtonVariant } from "@/components/Button";
import { elevation, radius } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import { useGlobalModal } from "@/providers/GlobalModalProvider";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";

export interface DialogAction {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  /** A glyph before the label, for an action whose shape is worth recognising — a trash on Delete. */
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  /** For a screen that needs to find this specific button — a primary submit, say. */
  testID?: string;
}

export interface DialogProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  /** A line under the title. Longer copy belongs in `children`. */
  description?: string;
  actions?: DialogAction[];
  /** Suppress the corner close button — a dialog that must be answered. */
  dismissible?: boolean;
}

/**
 * A modal that is a card in a browser and a bottom sheet on a device.
 *
 * `@gorhom/bottom-sheet` is the right shape on a phone and the wrong one at
 * 1440 px, where a panel sliding up from the bottom of a monitor reads as a
 * mobile app in a browser window — which is most of what "clunky" meant. So the
 * web gets a centred card with a scrim, Escape and click-outside; a phone and a
 * tablet keep the sheet they already had, through `useGlobalModal` (see
 * `openDialog` below).
 *
 * Both branches now land on a card in a browser: `SheetModal`
 * (`components/common/Sheet.web.tsx`) applies the same split to every modal in
 * the app, so `useGlobalModal` is no longer a sheet on the web either. This
 * component stays because it owns the dialog *shape* — title, description,
 * actions — not because the platforms differ here.
 *
 * The split used to be `isWebWide`, which sent a browser window under 768 px to
 * the sheet, and back then the sheet did not present on react-native-web at
 * all. Nothing appeared, no error was logged, and the dialog was simply not
 * there. Driving the player at 390x844 found it through the source chooser, and
 * the app's own overflow menu (`PlatformDropdown`, same global sheet) opened
 * nothing at that width either, which is what says the surface is at fault
 * rather than any one caller. A card at 342 px wide is a perfectly good phone
 * dialog; nothing at all is not.
 *
 * Never on TV: `docs/conventions/tv.md` rules out React Native's `Modal` and
 * absolutely positioned overlays there — a TV modal is an atom plus a
 * `router.push()`.
 */
export const Dialog: React.FC<PropsWithChildren<DialogProps>> = ({
  visible,
  onClose,
  title,
  description,
  actions,
  dismissible = true,
  children,
}) => {
  const { color } = useTheme();
  const { width } = useBreakpoint();
  // Not `isWebWide`: see above — a 342 px card is a fine phone dialog, and at
  // the time this was written the sheet presented nothing at all on the web.
  const isCard = Platform.OS === "web" && !Platform.isTV;
  const { showModal, hideModal } = useGlobalModal();

  const body = (
    <DialogBody
      title={title}
      description={description}
      actions={actions}
      onClose={onClose}
      dismissible={dismissible}
      showClose={isCard && dismissible}
    >
      {children}
    </DialogBody>
  );

  // Escape closes, the way every other dialog on the web does. Keyed on
  // `visible` so the listener only exists while the dialog is open.
  useEffect(() => {
    if (!visible || Platform.OS !== "web" || !dismissible) return;
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
  }, [visible, dismissible, onClose]);

  // Off the web the sheet provider owns presentation, so this component only
  // pushes content into it and takes it back out again.
  useEffect(() => {
    if (isCard) return;
    if (visible) showModal(body);
    else hideModal();
    // Deliberately keyed on `visible` alone. `body` is a fresh element every
    // render, so depending on it would re-present the sheet on each one and
    // reset whatever the user was doing inside it. A sheet whose content
    // changes while open should hold that state itself.
  }, [isCard, visible]);

  if (!isCard) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType='fade'
      onRequestClose={onClose}
      // Web's Modal is a plain overlay, so the scrim is ours to draw.
      statusBarTranslucent
    >
      <Pressable
        accessibilityRole='button'
        accessibilityLabel='Close'
        onPress={dismissible ? onClose : undefined}
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          backgroundColor: color.scrim,
        }}
      >
        {/* A Pressable inside a Pressable: the card swallows the press so a
            click on the dialog itself does not count as a click outside. */}
        <Pressable
          onPress={() => {}}
          style={[
            {
              width: "100%",
              maxWidth: Math.min(560, width - 48),
              maxHeight: "85%",
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: color.border.subtle,
              backgroundColor: color.bg["1"],
              paddingHorizontal: 24,
              paddingVertical: 20,
            },
            elevation(2),
          ]}
        >
          {body}
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const DialogBody: React.FC<
  PropsWithChildren<{
    title?: string;
    description?: string;
    actions?: DialogAction[];
    onClose: () => void;
    dismissible: boolean;
    showClose: boolean;
  }>
> = ({ title, description, actions, onClose, showClose, children }) => (
  <>
    {title ? (
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          marginBottom: description ? 4 : 12,
        }}
      >
        <Text variant='heading' weight='semibold' style={{ flex: 1 }}>
          {title}
        </Text>
        {showClose ? (
          <Pressable
            onPress={onClose}
            accessibilityRole='button'
            accessibilityLabel='Close'
            style={{ padding: 4, marginRight: -4 }}
          >
            <Icon name='close' size={20} tone='secondary' />
          </Pressable>
        ) : null}
      </View>
    ) : null}
    {description ? (
      <Text variant='body' tone='secondary' style={{ marginBottom: 12 }}>
        {description}
      </Text>
    ) : null}
    <ScrollView
      style={{ flexGrow: 0 }}
      contentContainerStyle={{ paddingBottom: actions?.length ? 4 : 0 }}
    >
      {children}
    </ScrollView>
    {actions?.length ? (
      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          marginTop: 16,
        }}
      >
        {actions.map((action, index) => (
          <Button
            key={action.label}
            testID={action.testID}
            variant={
              action.variant ??
              (index === actions.length - 1 ? "primary" : "ghost")
            }
            size='md'
            icon={action.icon}
            disabled={action.disabled}
            loading={action.loading}
            onPress={action.onPress}
            style={{ marginLeft: index === 0 ? 0 : 8 }}
          >
            {action.label}
          </Button>
        ))}
      </View>
    ) : null}
  </>
);

export interface DialogRequest {
  title?: string;
  description?: string;
  content?: ReactNode;
  actions?: DialogAction[];
  dismissible?: boolean;
}

/**
 * The imperative form, for the many places that want a dialog without holding
 * `visible` state: `const dialog = useDialog(); dialog.open({...})`.
 *
 * It renders through the same global modal as everywhere else — a modal
 * presented imperatively has no component to mount a `Modal` from, and the
 * provider is already at the root — which since `SheetModal` means it is a card
 * in a browser too. Prefer the `<Dialog>` component where a screen can hold the
 * state.
 */
export const useDialog = () => {
  const { showModal, hideModal } = useGlobalModal();

  const open = useCallback(
    (request: DialogRequest) => {
      showModal(
        <View style={{ paddingHorizontal: 24, paddingVertical: 16 }}>
          <DialogBody
            title={request.title}
            description={request.description}
            actions={request.actions}
            onClose={hideModal}
            dismissible={request.dismissible ?? true}
            showClose={false}
          >
            {request.content}
          </DialogBody>
        </View>,
      );
    },
    [showModal, hideModal],
  );

  return { open, close: hideModal };
};
