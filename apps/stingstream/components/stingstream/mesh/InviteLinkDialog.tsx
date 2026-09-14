import { getNodeBaseUrl } from "@stingstream/api-client";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { Text } from "@/components/common/Text";
import { radius } from "@/constants/theme";
import { primaryAddressFor, useNodeContext } from "@/hooks/useNodeContext";
import type { ConnectionInvite } from "@/lib/stingstream/connections";
import { useLeaveMeshGroup } from "@/lib/stingstream/mesh";
import { apiAtom } from "@/providers/JellyfinProvider";
import { buildInviteLink } from "@/utils/mesh/connectionLink";
import { copyInviteLink, openInNewTab } from "./openOrCopy";

/**
 * The invite link for `invite`, on the address the server chose for it.
 *
 * The server says where the link should point (its domain when one is set), because the page only
 * knows how it was reached and the LAN address the gateway advertised. Those are the fallbacks, for
 * a server too old to say.
 */
export const useInviteLinkFor = () => {
  const node = useNodeContext();
  const api = useAtomValue(apiAtom);
  const fallback = node
    ? primaryAddressFor(node)
    : api?.basePath
      ? getNodeBaseUrl(api.basePath)
      : null;
  return (invite: ConnectionInvite): string | null =>
    buildInviteLink(invite.address ?? fallback, invite);
};

/**
 * *Invite link ready*: a QR code for a phone across the room, the link, copy, open, and cancel.
 *
 * Cancel removes the pending connection the invite created, the same as the row's own cancel on the
 * Servers page, so every code minted for it stops working. It is offered only when the group is
 * known.
 */
export function InviteLinkDialog({
  link,
  group,
  onClose,
}: {
  link: string;
  group: string | null | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const leave = useLeaveMeshGroup();

  const cancel = () => {
    if (!group || leave.isPending) return;
    leave.mutate(group, {
      onSuccess: () => {
        toast.success(t("sharing.invitation_cancelled"));
        onClose();
      },
      onError: (e) => toast.error(e.message),
    });
  };

  return (
    <Dialog
      visible
      onClose={onClose}
      title={t("sharing.add_server_ready_title")}
      description={t("sharing.add_server_ready_detail")}
    >
      <View style={{ gap: 12 }}>
        <View style={{ alignItems: "center" }}>
          {/* White behind black whatever the theme: a scanner reads contrast, not the palette. */}
          <View
            testID='sharing-invite-qr'
            style={{
              padding: 12,
              borderRadius: radius.md,
              backgroundColor: "#FFFFFF",
            }}
          >
            <QRCode
              value={link}
              size={180}
              color='#000000'
              backgroundColor='#FFFFFF'
            />
          </View>
        </View>
        <Text
          testID='sharing-invite-link'
          variant='caption'
          tone='tertiary'
          numberOfLines={2}
          selectable
        >
          {link}
        </Text>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button
            testID='sharing-invite-copy'
            variant='primary'
            size='sm'
            icon='share'
            onPress={() => void copyInviteLink(link)}
          >
            {t("sharing.add_server_copy")}
          </Button>
          <Button
            testID='sharing-invite-open'
            variant='secondary'
            size='sm'
            icon='openExternal'
            onPress={() => openInNewTab(link)}
          >
            {t("sharing.add_server_open")}
          </Button>
          {group ? (
            <Button
              testID='sharing-invite-cancel'
              variant='danger'
              size='sm'
              icon='close'
              loading={leave.isPending}
              disabled={leave.isPending}
              onPress={cancel}
            >
              {t("sharing.invitation_cancel")}
            </Button>
          ) : null}
        </View>
      </View>
    </Dialog>
  );
}
