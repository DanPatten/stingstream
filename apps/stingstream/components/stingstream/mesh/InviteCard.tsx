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
 * An invite, as a link and as a QR of that link.
 *
 * An invite carries the group id, its **secret**, this node's address and the group's sharing
 * server — everything needed to become a member. So it is minted on demand rather than shown by
 * default, it is never cached by React Query, and the copy says plainly what handing it over means
 * and that removing a member later invalidates it.
 *
 * **A link, and only a link.** It used to be a 250-character base58 code, with the link added
 * beside it once nodes could build one. Dan, seeing both: *"QR code is fine but it should just be a
 * URL, no standalone code."* He is right — two representations of one secret is two things to
 * explain and two ways to send the wrong one. The code still exists inside the link, and
 * `JoinGroupScreen` still accepts a bare one because every invite handed out before this is one;
 * nothing hands one out any more.
 *
 * There is always a host to build a link from, because a node is seeded with a sharing server when
 * its database is first opened (`sharing::DEFAULT_SHARING_SERVER`). The one way to have none is to
 * clear that setting *and* have no domain of your own, which is a deliberate act by somebody who
 * knows what they are doing — so it gets an explanation rather than a silent fallback.
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

  useEffect(() => {
    mint.mutate(group);
    // Once per group. Re-minting on every render would hand out a new code each time the screen
    // re-rendered, which is harmless but makes the displayed code flicker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group]);

  const copy = useCallback(async () => {
    if (!link) return;
    if (Platform.OS === "web") {
      try {
        await navigator.clipboard.writeText(link);
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
    await Clipboard.setStringAsync(link);
    toast.success(t("sharing.invite_copied"));
  }, [link, t]);

  if (mint.isPending) return <LoadingState />;

  if (mint.error || !code) {
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

  // No host to point a link at. Reachable only by clearing the seeded sharing server *and* having
  // no domain, which is a deliberate act — so it gets a sentence saying which setting to look at,
  // rather than silently falling back to the 250-character code this screen just stopped showing.
  if (!link) {
    return (
      <View>
        <Text variant='body' weight='semibold'>
          {t("sharing.invite_no_host_title")}
        </Text>
        <Text variant='caption' tone='secondary' style={{ marginTop: 6 }}>
          {t("sharing.invite_no_host_detail")}
        </Text>
      </View>
    );
  }

  return (
    <View>
      <Text variant='caption' tone='secondary'>
        {t("sharing.invite_link_description", { group: groupName || group })}
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
            value={link}
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
          {link}
        </Text>
      </View>

      {!Platform.isTV && (
        <>
          <View style={{ height: 12 }} />
          <Button variant='secondary' icon='link' onPress={copy}>
            {t("sharing.invite_copy_link")}
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
    </View>
  );
}
