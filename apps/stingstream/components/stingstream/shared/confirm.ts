import { Alert, Platform } from "react-native";

/**
 * A yes/no question that works on every platform this app ships to.
 *
 * `Alert` renders *nothing at all* on react-native-web — not a fallback, not an
 * error, nothing — so a destructive action guarded by `Alert.alert` on the web
 * bundle silently does nothing when the user presses the button. That is the
 * worst of both worlds: the guard is gone and so is the action. `GroupDetailScreen`
 * hit this first and worked around it inline; every destructive action added in
 * M4.5 needs the same thing, so it lives here now.
 *
 * Resolves `true` when the user confirmed.
 */
export function confirmDestructive(
  title: string,
  message: string,
  confirmLabel = "Delete",
): Promise<boolean> {
  if (Platform.OS === "web") {
    return Promise.resolve(
      globalThis.confirm?.(`${title}\n\n${message}`) ?? false,
    );
  }
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
