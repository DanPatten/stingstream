import { useSyncExternalStore } from "react";
import { Platform, View } from "react-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { space } from "@/constants/theme";
import {
  actionSheetStore,
  toDialogItems,
} from "@/lib/platform/actionSheetStore";

/**
 * Every action sheet in a browser, drawn as a centred dialog.
 *
 * `showActionSheetWithOptions` is a bottom drawer on a phone, where it belongs.
 * In a browser the web build of `@expo/react-native-action-sheet` hands the
 * request to `actionSheetStore` instead, and this draws it the way every other
 * modal on the web is drawn: a card in the middle of the window, the choices
 * stacked, a destructive one in the danger style, and Cancel as the dialog's
 * own button. Escape and a click outside dismiss it, which answers with the
 * cancel index exactly as the native sheet does.
 *
 * Mounted once, in the root layout beside the toaster, so it covers every route
 * including the player. Renders nothing off the web.
 */
export const ActionSheetDialog: React.FC = () =>
  Platform.OS === "web" && !Platform.isTV ? <WebActionSheetDialog /> : null;

const WebActionSheetDialog: React.FC = () => {
  const request = useSyncExternalStore(
    actionSheetStore.subscribe,
    actionSheetStore.getSnapshot,
    actionSheetStore.getSnapshot,
  );
  const { choices, cancel } = request
    ? toDialogItems(request.options)
    : { choices: [], cancel: null };

  return (
    <Dialog
      visible={request != null}
      onClose={actionSheetStore.dismiss}
      title={request?.options.title}
      description={request?.options.message}
      actions={
        cancel
          ? [
              {
                label: cancel.label,
                variant: "secondary",
                onPress: () => actionSheetStore.select(cancel.index),
                testID: "action-sheet-cancel",
              },
            ]
          : undefined
      }
    >
      <View style={{ gap: space["2"] }} testID='action-sheet-dialog'>
        {choices.map((choice) => (
          <Button
            key={choice.index}
            testID={`action-sheet-option-${choice.index}`}
            variant={choice.destructive ? "danger" : "secondary"}
            size='md'
            disabled={choice.disabled}
            onPress={() => actionSheetStore.select(choice.index)}
          >
            {choice.label}
          </Button>
        ))}
      </View>
    </Dialog>
  );
};

export default ActionSheetDialog;
