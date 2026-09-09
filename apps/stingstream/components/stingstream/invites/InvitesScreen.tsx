import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { PageContainer } from "@/components/common/PageContainer";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import {
  useDeleteInvite,
  useInviteLink,
  useInvites,
} from "@/lib/stingstream/invites";
import type { InviteSummary, MintedInvite } from "@/lib/stingstream/invitesApi";
import { EmptyState, ErrorState, LoadingState } from "../shared/ScreenState";
import { InvitePerson, MintedInviteDialog } from "./InvitePerson";

/**
 * The invites this server has handed out.
 *
 * The **link** list, deliberately — not the people list. Who has access is the accounts on this
 * server, and that is what Sharing shows now; this is the shorter-lived thing beside it: links that
 * have gone out, and whether anybody has opened them yet.
 *
 * Two decisions Dan made are visible here and worth stating, because both could be read as
 * omissions:
 *
 * - **The inviter picks the libraries, per invite.** Not a role, not a default, not "everything I
 *   have". So the picker is part of minting rather than something to configure afterwards, and it
 *   refuses to mint with nothing chosen — a working link to an account that can see nothing looks
 *   like a bug on the other end and reads as a snub.
 * - **Only an administrator invites.** Holding an account on somebody's server does not let you
 *   hand out accounts on it. The route enforces it; the screen is behind `RequiresAdmin`.
 */
export function InvitesScreen() {
  const { t } = useTranslation();
  const invites = useInvites();
  const remove = useDeleteInvite();
  const link = useInviteLink();
  const [inviting, setInviting] = useState(false);
  const [showing, setShowing] = useState<MintedInvite | null>(null);

  /**
   * Re-open an invite's link.
   *
   * Only offered on invites nobody has opened: a redeemed one has no token left to show, and the
   * server answers with nothing rather than pretending. Fetched on the press rather than held in
   * the list, so a credential never sits in a query cache.
   */
  const openLink = (invite: InviteSummary) => {
    if (invite.status !== "valid") return;
    link.mutate(invite.id, {
      onSuccess: (result) => {
        if (result) setShowing(result);
        else toast.error(t("invites.link_gone"));
      },
      onError: (e) => toast.error(e.message),
    });
  };

  if (invites.isPending) return <LoadingState />;
  if (invites.error) {
    return (
      <ErrorState
        message={
          invites.error instanceof Error
            ? invites.error.message
            : t("invites.list_failed_title")
        }
        onRetry={() => invites.refetch()}
      />
    );
  }

  const rows = invites.data ?? [];

  return (
    <PageContainer width='settings'>
      <Text variant='caption' tone='secondary' style={{ marginBottom: 12 }}>
        {t("invites.screen_description")}
      </Text>

      <Button
        variant='primary'
        icon='invite'
        onPress={() => setInviting(true)}
        testID='invites-new'
      >
        {t("invites.new")}
      </Button>

      <View style={{ height: 20 }} />

      {rows.length === 0 ? (
        <EmptyState
          icon='invite'
          title={t("invites.empty_title")}
          detail={t("invites.empty_detail")}
        />
      ) : (
        <ListGroup title={t("invites.list_title")}>
          {rows.map((invite) => (
            <InviteRow
              key={invite.id}
              invite={invite}
              busy={remove.isPending || link.isPending}
              onPress={() => openLink(invite)}
              onDelete={() => {
                remove.mutate(invite.id, {
                  onSuccess: () => toast.success(t("invites.deleted")),
                  onError: (e) => toast.error(e.message),
                });
              }}
            />
          ))}
        </ListGroup>
      )}

      <InvitePerson visible={inviting} onClose={() => setInviting(false)} />

      <MintedInviteDialog minted={showing} onClose={() => setShowing(null)} />
    </PageContainer>
  );
}

/**
 * One invite in the list.
 *
 * A spent invite still shows the account it created, so an administrator looking at a name they do
 * not recognise can find where it came from. It is no longer the *only* record of that, which is
 * what made deleting one safe: the account itself is on the Sharing screen either way.
 */
const InviteRow: React.FC<{
  invite: InviteSummary;
  busy: boolean;
  onPress: () => void;
  onDelete: () => void;
}> = ({ invite, busy, onPress, onDelete }) => {
  const { t } = useTranslation();

  const tone =
    invite.status === "valid"
      ? "success"
      : invite.status === "used"
        ? "neutral"
        : "warning";

  const subtitle =
    invite.status === "used"
      ? t("invites.row_used", {
          name: invite.redeemedUserName ?? "",
          libraries: invite.libraries.map((l) => l.name).join(", "),
        })
      : t("invites.row_libraries", {
          libraries: invite.libraries.map((l) => l.name).join(", "),
        });

  return (
    <ListItem
      title={invite.label || t("invites.row_untitled")}
      subtitle={subtitle}
      // Only a live invite has a link to show. A spent one is a record, not a thing to open.
      onPress={invite.status === "valid" ? onPress : undefined}
      showArrow={invite.status === "valid"}
      iconAfter={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Pill label={t(`invites.status_${invite.status}`)} tone={tone} />
          {/* Every row can be deleted, spent or not. Withdrawing used to be offered only while an
              invite could still be used, because it was a state change on a row that stayed;
              deleting a row that is finished with is exactly what somebody tidying up wants. */}
          <Button
            variant='ghost'
            size='sm'
            icon='delete'
            disabled={busy}
            onPress={onDelete}
            accessibilityLabel={t("invites.delete")}
          >
            {""}
          </Button>
        </View>
      }
    />
  );
};
