import { requireOptionalNativeModule } from "expo";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { buildInviteLink } from "@/utils/mesh/inviteLink";
import { SharedLibrariesSection } from "./SharedLibraries";

/** What there is to say about a server somebody has just offered. */
export interface FinishedLink {
  status: "pending" | "approved" | "declined";
  issuerName: string;
  issuerAddress: string | null;
  groupId: string | null;
  code: string | null;
}

/**
 * The end of *Add server*: a link to open over there, and what you share once they accept.
 *
 * ## Why the answer is a link rather than a code
 *
 * Dan: *"after they enter their server url they should get a URL they can visit to link it (they
 * either share that link or open it right away - make sure its clickable, authenticate and
 * complete the link)"*.
 *
 * It used to be a base58 string with a *Copy* button and a sentence telling you to find the Accept
 * an invite screen on another server and paste it there. The code has not changed — this is the
 * same invite `InviteCard` hands out — but it is now wrapped in the address of the server it is
 * for, which is the one thing this flow knows and the old one did not. The code rides in the
 * **fragment**, which a browser never puts on the wire, for the reason every credential in this
 * system does.
 *
 * ## Why the link can be shared rather than only opened
 *
 * Only an administrator over there can accept it, and the person standing here may not be one.
 * Sending them the link is how the consent reaches somebody who can give it, and it is why this
 * offers a copy beside the open.
 *
 * ## Why the libraries are here
 *
 * A link starts closed: a group with no row shares nothing. The moment it is made is the one
 * moment its owner is certainly thinking about what to put in it, so the picker is the last thing
 * on this panel rather than something to go and find. It is the same control, over the same
 * endpoint, as the link's own page.
 */
export const AddServerFinish: React.FC<{
  link: FinishedLink;
  /** Drawn only for somebody who may choose what this server shares. */
  canChooseLibraries?: boolean;
  /**
   * Whether this is about the reader's own server rather than one they added.
   *
   * It changes the words and nothing else. This page never learns what somebody calls the server
   * they run, so a sentence with their server's name in it can only be filled with a placeholder,
   * and "Finish on The server you run" is what that produces. The sentences that need no name are
   * simply better sentences.
   */
  mine?: boolean;
}> = ({ link, canChooseLibraries = false, mine = false }) => {
  const { color } = useTheme();
  const { t } = useTranslation();

  const server = link.issuerName || t("sharing.server_untitled");
  const url = link.code ? buildInviteLink(link.issuerAddress, link.code) : null;

  const copy = useCallback(async () => {
    const text = url ?? link.code;
    if (!text) return;
    if (Platform.OS === "web") {
      try {
        await navigator.clipboard.writeText(text);
        toast.success(t("sharing.invite_copied"));
      } catch {
        toast.error(t("sharing.invite_copy_failed"));
      }
      return;
    }
    // Builds that do not ship the expo-clipboard native module: probe first, as the rest of the
    // app does.
    if (!requireOptionalNativeModule("ExpoClipboard")) {
      toast.error(t("sharing.invite_clipboard_unavailable"));
      return;
    }
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(text);
    toast.success(t("sharing.invite_copied"));
  }, [link.code, t, url]);

  const open = useCallback(() => {
    if (!url) return;
    if (Platform.OS === "web") {
      // A different origin, so a real navigation rather than a router push. A new tab, because
      // the page here is not finished with: the libraries below are still to be chosen.
      (globalThis as { open?: (u: string, target?: string) => void }).open?.(
        url,
        "_blank",
      );
      return;
    }
    void Linking.openURL(url);
  }, [url]);

  return (
    <View
      testID='sharing-add-server-finish'
      style={{
        padding: 16,
        borderRadius: radius.md,
        backgroundColor: color.bg["1"],
        gap: 12,
      }}
    >
      <View>
        <Text variant='body' weight='semibold'>
          {link.status === "approved"
            ? mine
              ? t("sharing.add_server_ready_title_mine")
              : t("sharing.add_server_ready_title", { server })
            : mine
              ? t("sharing.add_server_pending_title_mine")
              : t("sharing.add_server_pending_title", { server })}
        </Text>
        <Text variant='caption' tone='secondary' style={{ marginTop: 4 }}>
          {link.status === "approved"
            ? t("sharing.add_server_ready_detail")
            : mine
              ? t("sharing.add_server_pending_detail_mine")
              : t("sharing.add_server_pending_detail", { server })}
        </Text>
      </View>

      {url ? (
        <>
          {/* The link itself, readable: somebody about to send it to an administrator wants to
              see where it points before they do. Two lines at most, because the code is 250-odd
              base58 characters and at full height it was the largest thing on the page, above a
              control nobody has to read it to use. Copy link is how it travels. */}
          <Text
            testID='sharing-add-server-link'
            variant='caption'
            tone='tertiary'
            numberOfLines={2}
            selectable
          >
            {url}
          </Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Button
              testID='sharing-add-server-open'
              variant='primary'
              size='sm'
              icon='openExternal'
              onPress={open}
            >
              {mine
                ? t("sharing.add_server_open_mine")
                : t("sharing.add_server_open", { server })}
            </Button>
            <Button
              testID='sharing-add-server-copy'
              variant='secondary'
              size='sm'
              icon='share'
              onPress={() => void copy()}
            >
              {t("sharing.add_server_copy")}
            </Button>
          </View>
        </>
      ) : null}

      {/* No address to point the code at: an older request, or one that came in through the
          sign-in path. The code is still the whole of what is needed, so it is shown. */}
      {!url && link.code ? (
        <>
          <Text variant='caption' tone='tertiary' selectable>
            {link.code}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              testID='sharing-add-server-copy'
              variant='secondary'
              size='sm'
              icon='share'
              onPress={() => void copy()}
            >
              {t("sharing.add_server_copy_code")}
            </Button>
          </View>
        </>
      ) : null}

      {canChooseLibraries && link.groupId ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: color.border.subtle,
            paddingTop: 12,
          }}
        >
          <SharedLibrariesSection group={link.groupId} />
        </View>
      ) : null}
    </View>
  );
};
