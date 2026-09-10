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
import { useCreateMeshGroup, useNodeMeshGroups } from "@/lib/stingstream/mesh";
import { SegmentedControl } from "../shared/SegmentedControl";

/**
 * Servers waiting for an answer.
 *
 * Somebody who signed in here and also runs their own server can ask; only an administrator can
 * answer. That split is what keeps `docs/INVITES.md` §3's first row true — holding an account on
 * somebody's server does not let you decide anything about it — while still letting the person who
 * runs the other server start the conversation.
 *
 * **This is now the only way a link begins.** The page used to offer three ways at once — mint a
 * server invite, redeem one, or invite a person — and Dan's verdict was that nobody could tell them
 * apart: *"we shouldnt have both Link a server and Join with link and Invite a person instead.
 * thats too many fucking options ... lets greatly simplify it by only allowing linking through an
 * invitation from a user."* So there is one path: invite a **person** (Users & access), they sign
 * in, and if they run a server they ask to link it from their own settings. This is where that ask
 * arrives.
 *
 * **Approving still mints an ordinary group invite**, and there is no second protocol: the code
 * goes back to the person who asked and they redeem it on their own server, where what they share
 * back is their decision. What changed is that an administrator no longer has to have created a
 * "link" first — see `ensureGroup`.
 *
 * **The wording is an approval's, not a doorman's.** It said "Let them in" and "Say no"; Dan:
 * *"What the fuck kind of verbiage is that??"*. These are infrastructure decisions and they get the
 * words infrastructure uses.
 *
 * Draws nothing when nobody has asked — an empty heading on a page about links reads as a broken
 * feature rather than an unused one.
 */
export const LinkRequests: React.FC = () => {
  const { t } = useTranslation();
  const requests = useLinkRequests();
  const groups = useNodeMeshGroups();
  const createGroup = useCreateMeshGroup();
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
  const busy = approve.isPending || decline.isPending || createGroup.isPending;

  /**
   * The link to approve into, creating the first one if there is none.
   *
   * A "group" is plumbing — the mesh's unit of shared membership — and nobody arriving at this
   * screen asked for one. With the create button gone, a first approval on a fresh server would
   * otherwise fail with the server's own "create a link first", which is an instruction the UI no
   * longer offers a way to follow.
   */
  const ensureGroup = async (): Promise<string | null> => {
    if (available.length > 1) return group;
    if (available.length === 1) return null; // the server fills in the only one
    const created = await createGroup.mutateAsync({
      name: t("sharing.first_link_name"),
    });
    return created.group;
  };

  const onApprove = async () => {
    try {
      const groupId = await ensureGroup();
      await approve.mutateAsync({
        issuerNodeId: pending[0].issuerNodeId,
        groupId,
      });
      toast.success(t("sharing.requests_approved"));
    } catch (e) {
      // The server writes the sentence for "choose which link"; both it and a
      // failed create are the administrator's own next step.
      toast.error(
        e instanceof Error ? e.message : t("sharing.requests_failed"),
      );
    }
  };

  return (
    <View testID='sharing-requests' style={{ gap: 12 }}>
      <ListGroup title={t("sharing.requests_title")}>
        {pending.map((request) => (
          <ListItem
            key={request.issuerNodeId}
            testID='sharing-request'
            title={t("sharing.requests_wants_to_link", {
              server: request.issuerName || t("sharing.server_untitled"),
            })}
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

      {/* Decline is a ghost, not a second filled button. Two teal rectangles side by side is the
          "button war" Dan called out: nothing on the screen said which was the ordinary answer. */}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button
          testID='sharing-request-decline'
          variant='ghost'
          loading={decline.isPending}
          disabled={busy}
          onPress={() =>
            decline.mutate(pending[0].issuerNodeId, {
              onError: (e) => toast.error(e.message),
            })
          }
        >
          {t("sharing.requests_decline")}
        </Button>
        <Button
          testID='sharing-request-approve'
          variant='primary'
          loading={approve.isPending || createGroup.isPending}
          disabled={busy || (available.length > 1 && !group)}
          style={{ flex: 1 }}
          onPress={() => void onApprove()}
        >
          {t("sharing.requests_approve")}
        </Button>
      </View>
    </View>
  );
};
