import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import {
  useApproveLinkRequest,
  useDeclineLinkRequest,
  useLinkRequests,
} from "@/lib/stingstream/identity";
import { useCreateMeshGroup, useNodeMeshGroups } from "@/lib/stingstream/mesh";
import { ActionRow } from "../shared/ActionRow";
import { IconAction } from "../shared/IconAction";
import { SegmentedControl } from "../shared/SegmentedControl";

/**
 * Servers waiting for an answer.
 *
 * Somebody who signed in here and also runs their own server asks; only an administrator can
 * answer. That split is what keeps `docs/INVITES.md` §3's first row true — holding an account on
 * somebody's server does not let you decide anything about it — while still letting the person who
 * runs the other server start the conversation.
 *
 * **This is the only way a link begins.** The page used to offer three ways at once — mint a server
 * invite, redeem one, or invite a person — and Dan's verdict was that nobody could tell them apart:
 * *"lets greatly simplify it by only allowing linking through an invitation from a user."* So there
 * is one path: invite a **person** on Users & access, they sign in with their own server, and the
 * ask arrives here. Signing in that way submits it by itself; nobody has to find a button for it.
 *
 * **Approving mints an ordinary group invite**, and there is no second protocol: the code goes back
 * to the person who asked and they redeem it on their own server, where what they share back is
 * their decision.
 *
 * ## Why the answer is two icons
 *
 * It was a full-width teal *Approve* with a *Decline* beside it, under the row it applied to. Dan:
 * *"approve/decline should just be inline icons with hover text"*. A whole line of page for a
 * two-word decision, and it had to be read before it could be used; a tick and a cross on the row
 * they belong to do not.
 *
 * **And they now answer the row they sit on.** The buttons acted on `pending[0]` however many
 * requests were listed, so a second server could be approved by pressing the button under the
 * first. Per-row icons make that unsayable rather than merely fixed.
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
  /** The request currently being answered, so only its own icons spin. */
  const [answering, setAnswering] = useState<string | null>(null);

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

  const onApprove = async (issuerNodeId: string) => {
    setAnswering(issuerNodeId);
    try {
      const groupId = await ensureGroup();
      await approve.mutateAsync({ issuerNodeId, groupId });
      toast.success(t("sharing.requests_approved"));
    } catch (e) {
      // The server writes the sentence for "choose which link"; both it and a failed create are
      // the administrator's own next step.
      toast.error(
        e instanceof Error ? e.message : t("sharing.requests_failed"),
      );
    } finally {
      setAnswering(null);
    }
  };

  const onDecline = (issuerNodeId: string) => {
    setAnswering(issuerNodeId);
    decline.mutate(issuerNodeId, {
      onError: (e) => toast.error(e.message),
      onSettled: () => setAnswering(null),
    });
  };

  return (
    <View testID='sharing-requests' style={{ gap: 12 }}>
      <ListGroup title={t("sharing.requests_title")}>
        {pending.map((request) => {
          const answeringThis = answering === request.issuerNodeId;
          // Approving into a named link needs the choice below made first; declining never does.
          const cannotApprove = busy || (available.length > 1 && !group);
          return (
            <ActionRow
              key={request.issuerNodeId}
              testID='sharing-request'
              title={t("sharing.requests_wants_to_link", {
                server: request.issuerName || t("sharing.server_untitled"),
              })}
              subtitle={t("sharing.requests_asked_by", {
                name: request.requestedByName,
              })}
              leading={null}
              // Nothing to open: the request is the whole of what there is to know about it, and a
              // row that looks pressable and does nothing is worse than one that does not.
              onPress={() => {}}
              actions={
                <>
                  <IconAction
                    testID='sharing-request-approve'
                    icon='check'
                    tone='success'
                    label={t("sharing.requests_approve")}
                    busy={answeringThis && approve.isPending}
                    disabled={cannotApprove}
                    onPress={() => void onApprove(request.issuerNodeId)}
                  />
                  <IconAction
                    testID='sharing-request-decline'
                    icon='close'
                    tone='danger'
                    label={t("sharing.requests_decline")}
                    busy={answeringThis && decline.isPending}
                    disabled={busy}
                    onPress={() => onDecline(request.issuerNodeId)}
                  />
                </>
              }
            />
          );
        })}
      </ListGroup>

      {/* The choice, once, below the list rather than per row. Approving several servers into
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
    </View>
  );
};
