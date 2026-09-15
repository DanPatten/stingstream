import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import {
  useLinkedIdentities,
  useRemoveLinkedIdentity,
} from "@/lib/stingstream/identity";
import type { LinkedIdentity } from "@/lib/stingstream/identityApi";
import { confirmDestructive } from "../shared/confirm";

/**
 * The link, if any, that lets somebody on another server sign in to this account.
 *
 * Matched by the local account name, which is what the node reports for each link. Asked of the
 * whole list because the node has no per-account lookup, and the list is small: it only holds
 * people who have signed in from elsewhere, which on most servers is nobody.
 */
export function useLinkedIdentityFor(
  userName: string | null | undefined,
): LinkedIdentity | undefined {
  const links = useLinkedIdentities();
  if (!userName) return undefined;
  const wanted = userName.toLowerCase();
  return links.data?.find(
    (link) => link.localUserName?.toLowerCase() === wanted,
  );
}

/**
 * Which server vouches for one account, and how to stop it.
 *
 * Dan: *"remove 'Signed in from another server' section - show that on the user details instead"*.
 * It used to be a second list under the accounts, naming people who were already in the list above
 * it. It is a fact about one account, so it lives in that account's dialog.
 *
 * **Removing a link is not deleting an account.** These accounts have a password nobody knows, so
 * the link is the only way in and taking it away shuts the door, but what they watched and where
 * they got to is theirs, and stays. Deleting the account is the bin on its row.
 */
export const LinkedSignIn: React.FC<{ link: LinkedIdentity }> = ({ link }) => {
  const { t } = useTranslation();
  const remove = useRemoveLinkedIdentity();

  return (
    <View
      testID='user-linked'
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <Text variant='body' style={{ flex: 1 }}>
        {t("users.linked_from", {
          name: link.remoteUserName,
          server: link.issuerName || t("sharing.server_untitled"),
        })}
      </Text>
      <Button
        variant='danger'
        size='sm'
        disabled={remove.isPending}
        onPress={async () => {
          const confirmed = await confirmDestructive(
            t("users.linked_remove_confirm_title"),
            t("users.linked_remove_confirm_detail", {
              server: link.issuerName,
            }),
            t("users.linked_remove"),
          );
          if (!confirmed) return;
          remove.mutate(
            {
              issuerNodeId: link.issuerNodeId,
              // The id is `<node>/<remote user>`; everything after the first slash is theirs, and a
              // remote id could contain one.
              remoteUserId: link.id.slice(link.id.indexOf("/") + 1),
            },
            { onError: (e) => toast.error(e.message) },
          );
        }}
      >
        {t("users.linked_remove")}
      </Button>
    </View>
  );
};
