import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import {
  useApproveLinkRequest,
  useDeclineLinkRequest,
  useLinkRequests,
} from "@/lib/stingstream/identity";
import { useNodeMeshGroups } from "@/lib/stingstream/mesh";
import { SegmentedControl } from "../shared/SegmentedControl";

/**
 * Servers that have asked to be linked with this one.
 *
 * Somebody who signed in here with their own server can ask; only an administrator can answer.
 * That split is what keeps `docs/INVITES.md` §3's first row true — holding an account on somebody's
 * server does not let you decide anything about it — while still letting the person who runs the
 * other server start the conversation.
 *
 * **Approving mints an ordinary group invite.** There is no second kind of link and no new
 * protocol: the code goes back to the person who asked, and they redeem it on their own server
 * through the Join screen that has always existed. What they share back is then their decision, on
 * their machine, in the picker that already says "each side picks its own".
 *
 * Draws nothing at all when nobody has asked. An empty heading on a screen about links reads as a
 * feature that is broken rather than one nobody has used.
 */
export const LinkRequests: React.FC = () => {
  const { t } = useTranslation();
  const requests = useLinkRequests();
  const groups = useNodeMeshGroups();
  const approve = useApproveLinkRequest();
  const decline = useDeclineLinkRequest();

  // Which link to put them in. Only asked when there is more than one — with a single link there
  // is no choice to make, and the server fills it in itself.
  const [group, setGroup] = useState<string | null>(null);

  const pending = (requests.data ?? []).filter(
    (request) => request.status === "pending",
  );
  if (pending.length === 0) return null;

  const available = groups.data ?? [];
  const busy = approve.isPending || decline.isPending;

  return (
    <View style={{ gap: 12 }}>
      <ListGroup title={t("sharing.requests_title")}>
        {pending.map((request) => (
          <ListItem
            key={request.issuerNodeId}
            testID='sharing-request'
            title={request.issuerName || t("sharing.server_untitled")}
            subtitle={t("sharing.requests_asked_by", {
              name: request.requestedByName,
            })}
          />
        ))}
      </ListGroup>

      {/* The choice, once, above the buttons — rather than per row. Approving several servers into
          different links one at a time is rare enough that a picker on every row would be noise. */}
      {available.length > 1 ? (
        <View>
          <Text variant='caption' tone='secondary' weight='medium'>
            {t("sharing.requests_which_link")}
          </Text>
          <SegmentedControl
            layout='pills'
            segments={available.map((candidate) => ({
              key: candidate.group,
              label: candidate.name || t("sharing.server_untitled"),
            }))}
            value={group ?? ""}
            onChange={setGroup}
          />
        </View>
      ) : null}

      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button
          testID='sharing-request-approve'
          variant='primary'
          loading={approve.isPending}
          disabled={busy || (available.length > 1 && !group)}
          style={{ flex: 1 }}
          onPress={() =>
            approve.mutate(
              {
                issuerNodeId: pending[0].issuerNodeId,
                groupId: available.length > 1 ? group : null,
              },
              {
                onSuccess: () => toast.success(t("sharing.requests_approved")),
                // The server writes the sentence for "choose which link" and for "create a link
                // first"; both are the administrator's own next step.
                onError: (e) => toast.error(e.message),
              },
            )
          }
        >
          {t("sharing.requests_approve")}
        </Button>
        <Button
          testID='sharing-request-decline'
          variant='secondary'
          loading={decline.isPending}
          disabled={busy}
          style={{ flex: 1 }}
          onPress={() =>
            decline.mutate(pending[0].issuerNodeId, {
              onError: (e) => toast.error(e.message),
            })
          }
        >
          {t("sharing.requests_decline")}
        </Button>
      </View>
    </View>
  );
};
