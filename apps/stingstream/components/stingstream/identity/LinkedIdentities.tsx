import { useTranslation } from "react-i18next";
import { Text } from "@/components/common/Text";
import { useLinkedIdentities } from "@/lib/stingstream/identity";
import type { LinkedIdentity } from "@/lib/stingstream/identityApi";

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
 * Which server vouches for one account.
 *
 * Dan: *"remove 'Signed in from another server' section - show that on the user details instead"*.
 * It used to be a second list under the accounts, naming people who were already in the list above
 * it. It is a fact about one account, so it lives in that account's dialog.
 *
 * Read-only. It used to carry an Unlink button, and Dan asked for it gone: *"remove unlink button
 * completely.. not needed"*. Somebody who should not get in is disabled or deleted like any other
 * account.
 */
export const LinkedSignIn: React.FC<{ link: LinkedIdentity }> = ({ link }) => {
  const { t } = useTranslation();
  return (
    <Text testID='user-linked' variant='body'>
      {t("users.linked_from", {
        name: link.remoteUserName,
        server: link.issuerName || t("sharing.server_untitled"),
      })}
    </Text>
  );
};
