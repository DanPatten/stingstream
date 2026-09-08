import { requireOptionalNativeModule } from "expo";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";
import { useMintMeshInvite } from "@/lib/stingstream/mesh";
import { LoadingState } from "../shared/ScreenState";

/**
 * An invite code, as text and as a QR.
 *
 * An invite carries the group id, its **secret**, this node's address and the group's rendezvous
 * server — everything needed to become a member. So it is minted on demand rather than displayed
 * by default, it is never cached by React Query, and the copy says plainly what handing it over
 * means and that removing a member later invalidates it. base58check is what makes it survivable
 * when read aloud: no look-alike characters, and a checksum that catches a transposition before it
 * becomes a confusing join failure.
 *
 * **The link.** When this node has an address to build one from, the invite is handed out as
 * `https://<host>/join#<code>` — the same code, wrapped in something a person can open, which is
 * what people already know how to send each other. The code sits in the fragment, which a browser
 * never puts on the wire, so it stays out of the access log of every server and proxy the link
 * passes through. Where the host comes from is `sharing::invite_link` on the node.
 *
 * With no host the screen falls back to the bare code, unchanged. That is not a degraded state to
 * apologise for: a member who has configured no domain, in a group with no server, has nowhere to
 * point a link, and the code has always worked.
 *
 * The QR carries whichever of the two is on offer. A scanned link opens; a scanned code is an
 * opaque blob to anything that does not know what it is, which is the right outcome.
 *
 * Content only — no title, no outer card. `GroupDetailScreen` hosts this inside a `Dialog`, which
 * already supplies both; `CreateGroupScreen` hosts it inside its own `FormCard`, under a heading it
 * writes itself.
 */
export function InviteCard({
  group,
  groupName,
}: {
  group: string;
  groupName: string;
}) {
  const { t } = useTranslation();
  const mint = useMintMeshInvite();
  const code = mint.data?.code;
  const link = mint.data?.url ?? null;
  // One value for the QR, the copy button and the box below them, so the three can never disagree
  // about what was handed over.
  const shared = link ?? code;

  useEffect(() => {
    mint.mutate(group);
    // Once per group. Re-minting on every render would hand out a new code each time the screen
    // re-rendered, which is harmless but makes the displayed code flicker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group]);

  const copy = useCallback(async () => {
    if (!shared) return;
    if (Platform.OS === "web") {
      try {
        await navigator.clipboard.writeText(shared);
        toast.success(t("sharing.invite_copied"));
      } catch {
        toast.error(t("sharing.invite_copy_failed"));
      }
      return;
    }
    // Builds that do not ship the expo-clipboard native module: probe first, as the rest of the
    // app does (components/settings/QuickConnect.tsx).
    if (!requireOptionalNativeModule("ExpoClipboard")) {
      toast.error(t("sharing.invite_clipboard_unavailable"));
      return;
    }
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(shared);
    toast.success(t("sharing.invite_copied"));
  }, [shared, t]);

  if (mint.isPending) return <LoadingState />;

  if (mint.error || !code || !shared) {
    return (
      <View>
        <Text variant='body' weight='semibold' tone='danger'>
          {t("sharing.invite_mint_failed_title")}
        </Text>
        <Text variant='caption' tone='secondary' style={{ marginTop: 4 }}>
          {mint.error instanceof Error
            ? mint.error.message
            : t("common.something_went_wrong")}
        </Text>
        <View style={{ height: 12 }} />
        <Button variant='secondary' onPress={() => mint.mutate(group)}>
          {t("sharing.try_again")}
        </Button>
      </View>
    );
  }

  return (
    <View>
      <Text variant='caption' tone='secondary'>
        {t(
          link
            ? "sharing.invite_link_description"
            : "sharing.invite_description",
          { group: groupName || group },
        )}
      </Text>

      <View style={{ alignItems: "center", marginVertical: 16 }}>
        <View
          style={{
            padding: 12,
            borderRadius: radius.md,
            backgroundColor: "#FFFFFF",
          }}
        >
          <QRCode
            value={shared}
            size={Platform.isTV ? 260 : 200}
            color='#000000'
            backgroundColor='#FFFFFF'
          />
        </View>
      </View>

      <View
        style={{
          borderRadius: radius.sm,
          backgroundColor: tokens.color.bg["2"],
          padding: 12,
        }}
      >
        <Text variant='caption' selectable>
          {shared}
        </Text>
      </View>

      {!Platform.isTV && (
        <>
          <View style={{ height: 12 }} />
          <Button variant='secondary' icon='link' onPress={copy}>
            {t(link ? "sharing.invite_copy_link" : "sharing.invite_copy_code")}
          </Button>
        </>
      )}

      <View style={{ flexDirection: "row", marginTop: 12 }}>
        <Icon
          name='warning'
          tone='tertiary'
          size={14}
          style={{ marginTop: 2 }}
        />
        <Text
          variant='caption'
          tone='tertiary'
          style={{ marginLeft: 6, flex: 1 }}
        >
          {t("sharing.invite_note_online")}
        </Text>
      </View>
      <View style={{ flexDirection: "row", marginTop: 6 }}>
        <Icon
          name='warning'
          tone='tertiary'
          size={14}
          style={{ marginTop: 2 }}
        />
        <Text
          variant='caption'
          tone='tertiary'
          style={{ marginLeft: 6, flex: 1 }}
        >
          {t("sharing.invite_note_revocation")}
        </Text>
      </View>
      {/* Otherwise the only honest reading of a code where a link was expected is that something
          is broken. It is a setting nobody has filled in, and saying so is one line. */}
      {!link && (
        <View style={{ flexDirection: "row", marginTop: 6 }}>
          <Icon
            name='info'
            tone='tertiary'
            size={14}
            style={{ marginTop: 2 }}
          />
          <Text
            variant='caption'
            tone='tertiary'
            style={{ marginLeft: 6, flex: 1 }}
          >
            {t("sharing.invite_note_no_link")}
          </Text>
        </View>
      )}
    </View>
  );
}
