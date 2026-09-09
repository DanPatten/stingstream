import { Alert, Platform } from "react-native";
import { requestConfirm } from "@/utils/appDialog";

/**
 * A yes/no question that works on every platform this app ships to.
 *
 * ## Neither of the two obvious answers was right
 *
 * `Alert.alert` renders *nothing at all* on react-native-web — not a fallback, not an error,
 * nothing — so a destructive action guarded by it on the web bundle silently did nothing when the
 * button was pressed. That is the worst of both worlds: the guard is gone and so is the action.
 *
 * The first fix here was `globalThis.confirm`, which at least drew something. Dan: *"NEVER use
 * browser's alert function - replace them with proper modals"*, and he is right — it puts the
 * page's hostname above the question, cannot be styled to look like the rest of the app, blocks
 * the JS thread, and in most browsers offers "prevent this page from creating more dialogs",
 * which turns every later confirmation into a silent automatic no.
 *
 * So the answer is the app's own `Dialog`, driven from `utils/appDialog.ts` and rendered by
 * `AppDialogHost` at the root.
 *
 * **Television keeps `Alert.alert`**, and that is deliberate rather than an oversight: there it is
 * a real native control that a remote can drive, and `docs/conventions/tv.md` rules out the
 * overlay kind of modal on that platform outright.
 *
 * Resolves `true` when the user confirmed.
 */
export function confirmDestructive(
  title: string,
  message: string,
  confirmLabel = "Delete",
): Promise<boolean> {
  if (Platform.isTV) {
    return new Promise((resolve) => {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        {
          text: confirmLabel,
          style: "destructive",
          onPress: () => resolve(true),
        },
      ]);
    });
  }

  return requestConfirm({
    title,
    message,
    confirmLabel,
    destructive: true,
  });
}

/**
 * The same question when the answer is not destructive — "request all seasons?", say.
 *
 * Separate from `confirmDestructive` only so the confirm button is not red: a red button on an
 * ordinary action is the boy who cried wolf, and it is the red ones that need to still mean
 * something.
 */
export function confirmAction(
  title: string,
  message: string,
  confirmLabel?: string,
): Promise<boolean> {
  if (Platform.isTV) {
    return new Promise((resolve) => {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: confirmLabel ?? "OK", onPress: () => resolve(true) },
      ]);
    });
  }

  return requestConfirm({ title, message, confirmLabel, destructive: false });
}
