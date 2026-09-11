import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { ListGroup } from "@/components/list/ListGroup";
import useRouter from "@/hooks/useAppRouter";
import {
  useApproveLinkRequest,
  useDeclineLinkRequest,
  useForgetLinkRequest,
  useLinkRequests,
} from "@/lib/stingstream/identity";
import { ActionRow } from "../shared/ActionRow";
import { IconAction } from "../shared/IconAction";

/**
 * Servers waiting for an answer.
 *
 * Somebody who runs their own server asks; only an administrator can answer. That split is what
 * keeps `docs/INVITES.md` §3's first row true — holding an account on somebody's server does not
 * let you decide anything about it — while still letting the person who runs the other server
 * start the conversation.
 *
 * **There are two ways to ask now, and this answers both.** A person invited here who signs in
 * with their own server submits one on the way past, and a member who already has an account here
 * submits one from Settings, Servers, *Add server*. Both land in this queue, and an
 * administrator's own *Add server* never does: it is approved as it is made, because putting that
 * question to the person who answers it is not a safeguard.
 *
 * **Approving makes the link.** One per server, named after that server, so what this server
 * shares can be chosen per server rather than once for everybody. That is what deleted this
 * screen's other control — with no pool of links to choose from, "which of your links should they
 * join?" has nothing left to mean. The invite goes back to whoever asked and they finish on their
 * own server, where what they share back is their decision.
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
 * ## Why the ones already said no to are still listed
 *
 * Because a decline is permanent, and was invisible. The row is kept so that asking again cannot
 * get a different answer — an administrator who said no has said no — and the cost of that is a
 * server nobody can ever offer again, decided by a tap that may have been a mistake, on a screen
 * that then showed no trace of it. The next person to try would have gone looking for a fault in
 * the other server.
 *
 * So they stay, plainly marked, with one control: forget it, and let them ask again. That is the
 * only way back, and it is deliberately not an *Approve* — the next ask is a fresh question and
 * deserves a fresh answer.
 *
 * Draws nothing when nobody has asked — an empty heading on a page about links reads as a broken
 * feature rather than an unused one.
 */
export const LinkRequests: React.FC = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const requests = useLinkRequests();
  const approve = useApproveLinkRequest();
  const decline = useDeclineLinkRequest();
  const forget = useForgetLinkRequest();

  /** The request currently being answered, so only its own icons spin. */
  const [answering, setAnswering] = useState<string | null>(null);

  // Approved ones are not here: they are a link, and a link is a row on the list above.
  const rows = (requests.data ?? []).filter(
    (request) => request.status === "pending" || request.status === "declined",
  );
  if (rows.length === 0) return null;

  const busy = approve.isPending || decline.isPending || forget.isPending;

  const onApprove = async (issuerNodeId: string) => {
    setAnswering(issuerNodeId);
    try {
      // Null, always: the server makes the link and names it after them. An explicit group is
      // still honoured by the endpoint, for adding a third server to a link that exists, and
      // there is no screen for that yet because nobody has wanted one.
      await approve.mutateAsync({ issuerNodeId, groupId: null });
      toast.success(t("sharing.requests_approved"));

      // Straight to the link that was just made. A link starts closed, so the next thing that
      // matters is which libraries go into it, and leaving somebody on this page would mean the
      // approval appeared to do nothing until they went looking for it.
      //
      // Read back rather than returned: approve answers 204, and widening it to return the row
      // would put the invite code it also holds within reach of a screen that has no use for one.
      const group = (await requests.refetch()).data?.find(
        (r) => r.issuerNodeId === issuerNodeId,
      )?.groupId;
      if (group) router.push(`/settings/servers/${group}`);
    } catch (e) {
      // Core writes the sentence for every way this fails, and each one already ends in what the
      // administrator's own next step is.
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

  const onForget = (issuerNodeId: string) => {
    setAnswering(issuerNodeId);
    forget.mutate(issuerNodeId, {
      onSuccess: () => toast.success(t("sharing.requests_forgotten")),
      onError: (e) => toast.error(e.message),
      onSettled: () => setAnswering(null),
    });
  };

  return (
    <View testID='sharing-requests' style={{ gap: 12 }}>
      <ListGroup title={t("sharing.requests_title")}>
        {rows.map((request) => {
          const answeringThis = answering === request.issuerNodeId;
          const declined = request.status === "declined";
          return (
            <ActionRow
              key={request.issuerNodeId}
              testID={declined ? "sharing-request-declined" : "sharing-request"}
              title={t("sharing.requests_wants_to_link", {
                server: request.issuerName || t("sharing.server_untitled"),
              })}
              subtitle={
                declined
                  ? t("sharing.requests_declined_detail")
                  : t("sharing.requests_asked_by", {
                      name: request.requestedByName,
                    })
              }
              leading={null}
              // Nothing to open: the request is the whole of what there is to know about it, and a
              // row that looks pressable and does nothing is worse than one that does not.
              onPress={() => {}}
              actions={
                declined ? (
                  <IconAction
                    testID='sharing-request-forget'
                    icon='refresh'
                    label={t("sharing.requests_forget")}
                    busy={answeringThis && forget.isPending}
                    disabled={busy}
                    onPress={() => onForget(request.issuerNodeId)}
                  />
                ) : (
                  <>
                    <IconAction
                      testID='sharing-request-approve'
                      icon='check'
                      tone='success'
                      label={t("sharing.requests_approve")}
                      busy={answeringThis && approve.isPending}
                      disabled={busy}
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
                )
              }
            />
          );
        })}
      </ListGroup>
    </View>
  );
};
