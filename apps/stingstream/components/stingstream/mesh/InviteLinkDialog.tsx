import { getNodeBaseUrl } from "@stingstream/api-client";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { Text } from "@/components/common/Text";
import { primaryAddressFor, useNodeContext } from "@/hooks/useNodeContext";
import type { ConnectionInvite } from "@/lib/stingstream/connections";
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

/** *Invite link ready*: the link, with copy and open. */
export function InviteLinkDialog({
  link,
  onClose,
}: {
  link: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      visible
      onClose={onClose}
      title={t("sharing.add_server_ready_title")}
      description={t("sharing.add_server_ready_detail")}
    >
      <View style={{ gap: 12 }}>
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
        </View>
      </View>
    </Dialog>
  );
}
