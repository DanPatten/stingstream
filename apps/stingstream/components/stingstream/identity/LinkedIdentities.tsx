import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import {
  useLinkedIdentities,
  useRemoveLinkedIdentity,
} from "@/lib/stingstream/identity";
import { confirmDestructive } from "../shared/confirm";

/**
 * Accounts here that belong to somebody on another server.
 *
 * On the Users screen because that screen answers "who can get in", and these are people who can —
 * with a credential this server never issued and cannot see. They appear in the list above as
 * ordinary accounts, because that is what they are; what this section adds is the half that is not
 * visible there: **which** server vouches for them, and how to stop it.
 *
 * **Removing a link is not deleting an account.** These accounts have a password nobody knows, so
 * the link is the only way in and taking it away shuts the door — but what they watched and where
 * they got to is theirs, and stays. Deleting the account itself is the row above, and is a separate
 * decision.
 *
 * Draws nothing when nobody has ever signed in from elsewhere, which is most servers.
 */
export const LinkedIdentities: React.FC = () => {
  const { t } = useTranslation();
  const links = useLinkedIdentities();
  const remove = useRemoveLinkedIdentity();

  const rows = links.data ?? [];
  if (rows.length === 0) return null;

  return (
    <View style={{ marginTop: 20 }}>
      <ListGroup title={t("users.linked_title")}>
        {rows.map((link) => (
          <ListItem
            key={link.id}
            testID='users-linked'
            title={link.localUserName || link.remoteUserName}
            subtitle={t("users.linked_from", {
              name: link.remoteUserName,
              server: link.issuerName || t("sharing.server_untitled"),
            })}
          >
            {/* `danger`, not a red-tinted ghost: unlinking is the destructive half of this row and
                the palette already has one word for that. */}
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
                    // The id is `<node>/<remote user>`; everything after the first slash is
                    // theirs, and a remote id could contain one.
                    remoteUserId: link.id.slice(link.id.indexOf("/") + 1),
                  },
                  { onError: (e) => toast.error(e.message) },
                );
              }}
            >
              {t("users.linked_remove")}
            </Button>
          </ListItem>
        ))}
      </ListGroup>
    </View>
  );
};
