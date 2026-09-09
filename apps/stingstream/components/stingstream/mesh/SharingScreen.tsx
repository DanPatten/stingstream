import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { EmptyState } from "@/components/common/EmptyState";
import { Icon } from "@/components/common/Icon";
import { PageContainer } from "@/components/common/PageContainer";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { tokens } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useInvites } from "@/lib/stingstream/invites";
import type { InviteSummary } from "@/lib/stingstream/invitesApi";
import {
  groupCounts,
  MeshUnavailableError,
  useNodeMeshGroups,
  useNodeMeshPeers,
} from "@/lib/stingstream/mesh";
import { Disclosure } from "../shared/Disclosure";
import { GapNotice } from "../shared/GapNotice";
import { useIsStingStreamAdmin } from "../shared/RequiresAdmin";
import { QueryState } from "../shared/ScreenState";
import { DeviceMeshSection } from "./DeviceMeshSection";
import { SharingAddresses } from "./SharingAddresses";

/**
 * Who can see your things.
 *
 * ## Why this replaced the Groups screen
 *
 * Dan: *"Sharing doesnt work how I envision it. It needs to be simplier and not a 'group' persay.
 * I want the ability as the server owner to either invite end users (they dont own another server)
 * or other server owners."*
 *
 * "Group" is what the mesh calls a gossip topic with a shared secret. It is the right word for the
 * transport and the wrong word for the product: nobody sets out to create a group, they set out to
 * let their sister watch their films, or to pool a library with a friend who also runs a server.
 * The old screen asked you to name a group before it would let you do either.
 *
 * So this screen has two nouns, both of which a person already has a word for, and one button that
 * asks the only question that actually matters — which of the two you mean.
 *
 * Both halves already existed and had never been told apart: person invites create an account
 * **here** scoped to libraries you pick (`Invites/`), and a server link makes each side's libraries
 * appear on the other. What was missing was the app ever saying so.
 */
export function SharingScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const isAdmin = useIsStingStreamAdmin();
  const groups = useNodeMeshGroups();
  const peers = useNodeMeshPeers(null);
  const invites = useInvites();
  const [choosing, setChoosing] = useState(false);

  const people = useMemo(
    () => (invites.data ?? []).filter((i) => i.status !== "revoked"),
    [invites.data],
  );
  const servers = groups.data ?? [];

  // A server whose mesh child is down answers 503, and that is emphatically not "you share with
  // nobody" — showing the empty state would tell the user their links had vanished. It gets its own
  // line, and this device's own status card still renders above it, because the phone's mesh is a
  // separate thing that may well be fine.
  if (groups.error instanceof MeshUnavailableError) {
    return (
      <PageContainer width='settings'>
        <DeviceMeshSection />
        <View style={{ height: 16 }} />
        <GapNotice
          title={t("sharing.mesh_unavailable_title")}
          detail={t("sharing.mesh_unavailable_detail")}
        />
      </PageContainer>
    );
  }

  const nothingYet = people.length === 0 && servers.length === 0;

  return (
    <PageContainer width='settings'>
      <DeviceMeshSection />
      <View style={{ height: 16 }} />

      <QueryState
        isLoading={groups.isLoading}
        error={groups.error}
        onRetry={groups.refetch}
      >
        {nothingYet ? (
          <EmptyState
            icon='share'
            title={t("sharing.empty_title")}
            detail={t("sharing.empty_detail")}
          />
        ) : null}

        {people.length > 0 ? (
          <ListGroup title={t("sharing.people_title")}>
            {people.map((invite) => (
              <PersonRow
                key={invite.id}
                invite={invite}
                onPress={() => router.push("/settings/invites")}
              />
            ))}
          </ListGroup>
        ) : null}

        {servers.length > 0 ? (
          <View style={{ marginTop: people.length > 0 ? 16 : 0 }}>
            <ListGroup title={t("sharing.servers_title")}>
              {servers.map((group) => {
                const counts = groupCounts(peers.data, group.group);
                return (
                  <ListItem
                    key={group.group}
                    testID='sharing-server'
                    title={group.name || t("sharing.server_untitled")}
                    subtitle={t("sharing.server_members", {
                      count: counts.members,
                      online: counts.online,
                    })}
                    showArrow
                    onPress={() =>
                      router.push(`/settings/groups/${group.group}`)
                    }
                    iconAfter={
                      <Icon
                        name='devices'
                        size={16}
                        color={
                          counts.online > 0
                            ? tokens.color.state.success
                            : tokens.color.text.tertiary
                        }
                      />
                    }
                  />
                );
              })}
            </ListGroup>
          </View>
        ) : null}
      </QueryState>

      <View style={{ height: 20 }} />

      {isAdmin ? (
        <Button
          testID='sharing-invite'
          variant='primary'
          size='lg'
          icon='invite'
          onPress={() => setChoosing(true)}
        >
          {t("sharing.invite")}
        </Button>
      ) : (
        // A non-administrator sees the same list with no button and a reason, rather than a button
        // that would answer 403. Handing out access to somebody's server is a decision about their
        // disk, their bandwidth and their library.
        <Text variant='caption' tone='tertiary' align='center'>
          {t("sharing.admin_only")}
        </Text>
      )}

      {isAdmin ? (
        <Disclosure title={t("sharing.advanced")}>
          <SharingAddresses />
        </Disclosure>
      ) : null}

      <InviteChooser
        visible={choosing}
        onClose={() => setChoosing(false)}
        onPerson={() => {
          setChoosing(false);
          router.push("/settings/invites");
        }}
        onServer={() => {
          setChoosing(false);
          router.push("/settings/groups/create");
        }}
      />
    </PageContainer>
  );
}

/**
 * One invited person.
 *
 * A spent invite stays in the list rather than disappearing, showing the account it created: an
 * administrator looking at a name they do not recognise in Users should be able to find where it
 * came from, and this is the only record of it.
 */
const PersonRow: React.FC<{ invite: InviteSummary; onPress: () => void }> = ({
  invite,
  onPress,
}) => {
  const { t } = useTranslation();
  const libraries = invite.libraries.map((l) => l.name).join(", ");

  return (
    <ListItem
      testID='sharing-person'
      title={
        invite.status === "used"
          ? (invite.redeemedUserName ?? t("invites.row_untitled"))
          : invite.label || t("invites.row_untitled")
      }
      subtitle={libraries}
      showArrow
      onPress={onPress}
      iconAfter={
        <Pill
          label={t(
            invite.status === "used"
              ? "sharing.person_active"
              : invite.status === "expired"
                ? "sharing.person_expired"
                : "sharing.person_pending",
          )}
          tone={invite.status === "used" ? "success" : "neutral"}
          emphasis='soft'
        />
      }
    />
  );
};

/**
 * The one question worth asking, in the user's terms rather than the transport's.
 *
 * Not "create or join a group" — which is what the old screen asked, and which requires knowing
 * what a group is before you can answer. These two are things people already have words for, and
 * the difference between them is real: one gets an account here, the other keeps their own server.
 */
const InviteChooser: React.FC<{
  visible: boolean;
  onClose: () => void;
  onPerson: () => void;
  onServer: () => void;
}> = ({ visible, onClose, onPerson, onServer }) => {
  const { t } = useTranslation();

  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={t("sharing.chooser_title")}
    >
      <View style={{ gap: 8 }}>
        <ListItem
          testID='sharing-invite-person'
          title={t("sharing.chooser_person")}
          subtitle={t("sharing.chooser_person_hint")}
          icon='invite'
          showArrow
          onPress={onPerson}
        />
        <ListItem
          testID='sharing-invite-server'
          title={t("sharing.chooser_server")}
          subtitle={t("sharing.chooser_server_hint")}
          icon='devices'
          showArrow
          onPress={onServer}
        />
      </View>
    </Dialog>
  );
};
