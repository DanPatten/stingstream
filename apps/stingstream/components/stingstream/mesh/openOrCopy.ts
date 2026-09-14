import { requireOptionalNativeModule } from "expo";
import { t } from "i18next";
import { Linking, Platform } from "react-native";
import { toast } from "sonner-native";

/** Copy an invite link, and say so. */
export async function copyInviteLink(text: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("sharing.invite_copied"));
    } catch {
      toast.error(t("sharing.invite_copy_failed"));
    }
    return;
  }
  // Builds that do not ship the expo-clipboard native module: probe first, as the rest of the app
  // does.
  if (!requireOptionalNativeModule("ExpoClipboard")) {
    toast.error(t("sharing.invite_clipboard_unavailable"));
    return;
  }
  const Clipboard = await import("expo-clipboard");
  await Clipboard.setStringAsync(text);
  toast.success(t("sharing.invite_copied"));
}

/** Open a link on another server: a new tab on the web, the browser on a device. */
export function openInNewTab(url: string): void {
  if (Platform.OS === "web") {
    (globalThis as { open?: (u: string, target?: string) => void }).open?.(
      url,
      "_blank",
    );
    return;
  }
  void Linking.openURL(url);
}

/**
 * Go to another server in this window, for a journey that continues there.
 *
 * A full navigation rather than a router push: the destination is a different origin, and the
 * router only knows about this one. On a device the app is not a page, so the browser opens it.
 */
export async function goToServer(url: string): Promise<void> {
  if (Platform.OS === "web") {
    (globalThis as { location?: { assign?: (u: string) => void } }).location
      ?.assign?.(url);
    return;
  }
  const WebBrowser = await import("expo-web-browser");
  await WebBrowser.openBrowserAsync(url);
}
