import {
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useEffect,
} from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { Button, type ButtonVariant } from "@/components/Button";
import { elevation, radius, tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useGlobalModal } from "@/providers/GlobalModalProvider";
import { Icon } from "./Icon";
import { Text } from "./Text";

export interface DialogAction {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
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
 * A modal that is a card on a desktop browser and a bottom sheet everywhere
 * else.
 *
 * `@gorhom/bottom-sheet` is the right shape on a phone and the wrong one at
 * 1440 px, where a panel sliding up from the bottom of a monitor reads as a
 * mobile app in a browser window — which is most of what "clunky" meant. So
 * `isWebWide` gets a centred card with a scrim, Escape and click-outside; every
 * other surface keeps the sheet it already had, through `useGlobalModal` (see
 * `openDialog` below).
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
  const { isWebWide, width } = useBreakpoint();
  const { showModal, hideModal } = useGlobalModal();

  const body = (
    <DialogBody
      title={title}
      description={description}
      actions={actions}
      onClose={onClose}
      dismissible={dismissible}
      showClose={isWebWide && dismissible}
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

  // Off the wide web the sheet provider owns presentation, so this component
  // only pushes content into it and takes it back out again.
  useEffect(() => {
    if (isWebWide) return;
    if (visible) showModal(body);
    else hideModal();
    // Deliberately keyed on `visible` alone. `body` is a fresh element every
    // render, so depending on it would re-present the sheet on each one and
    // reset whatever the user was doing inside it. A sheet whose content
    // changes while open should hold that state itself.
  }, [isWebWide, visible]);

  if (!isWebWide) return null;

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
          backgroundColor: tokens.color.scrim.backdrop,
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
              borderColor: tokens.color.border.subtle,
              backgroundColor: tokens.color.bg["1"],
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
            variant={
              action.variant ??
              (index === actions.length - 1 ? "primary" : "ghost")
            }
            size='md'
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
 * On the wide web it renders through the same sheet provider as everywhere
 * else — a modal presented imperatively has no component to mount a `Modal`
 * from, and the provider is already at the root. Prefer the `<Dialog>`
 * component where a screen can hold the state; it is the one that becomes a
 * card on a desktop.
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
