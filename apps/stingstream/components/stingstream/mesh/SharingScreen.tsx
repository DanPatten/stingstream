import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useState } from "react";
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
import { useServerUsers } from "@/lib/stingstream/serverUsers";
import { userAtom } from "@/providers/JellyfinProvider";
import { InvitePerson } from "../invites/InvitePerson";
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
 * ## Why People is accounts rather than invites
 *
 * It was the invite list, which read correctly right up until an invite could be deleted. Dan
 * asked for exactly that — *"When deleteing an invite dont say withdrawn - just delete it"* — and
 * deleting a spent one would have made the person it created vanish from this screen, as a side
 * effect of tidying up a link.
 *
 * His own sentence in the same message settles it: *"sharing is basically just users not groups at
 * this point."* So People is the accounts on this server, with invitations nobody has opened yet
 * listed alongside as what they are — pending. It survives a deletion, and it picks up anybody an
 * administrator created by hand, who was never in the invite list at all.
 */
export function SharingScreen({
  openAdvanced = false,
}: {
  openAdvanced?: boolean;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const isAdmin = useIsStingStreamAdmin();
  const groups = useNodeMeshGroups();
  const peers = useNodeMeshPeers(null);
  // Administrator only: both are elevated routes, and a non-administrator asking gets a 403 it can
  // do nothing with. They still see the Servers half, which is not elevated.
  const invites = useInvites(isAdmin);
  const users = useServerUsers(isAdmin);
  const me = useAtomValue(userAtom);
  const [choosing, setChoosing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [advanced, setAdvanced] = useState(openAdvanced);

  const people = useMemo<PersonEntry[]>(() => {
    const accounts: PersonEntry[] = (users.data ?? [])
      // Not yourself. This is the list of people who can see your things, and you are not one of
      // them — without this a brand-new server opens on "People: dan", which reads as though the
      // owner had shared their library with themselves, and the "Nobody yet" empty state could
      // never appear at all.
      .filter((user) => user.Id !== me?.Id)
      .map((user) => ({
        key: `user:${user.Id}`,
        name: user.Name ?? t("sharing.person_unnamed"),
        state: user.Policy?.IsDisabled ? "disabled" : "active",
        user,
      }));

    // Only invitations nobody has opened. A spent one describes an account that is already in the
    // list above, and showing both would count the same person twice.
    const pending: PersonEntry[] = (invites.data ?? [])
      .filter((invite) => invite.status === "valid")
      .map((invite) => ({
        key: `invite:${invite.id}`,
        name: invite.label || t("invites.row_untitled"),
        state: "pending",
        invite,
      }));

    return [...accounts, ...pending];
  }, [invites.data, me?.Id, t, users.data]);

  const servers = groups.data ?? [];

  const openAddress = useCallback(() => setAdvanced(true), []);

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
            {people.map((person) => (
              <PersonRow
                key={person.key}
                person={person}
                onPress={() =>
                  router.push(
                    person.invite ? "/settings/invites" : "/settings/admin",
                  )
                }
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
        <Disclosure title={t("sharing.advanced")} defaultOpen={advanced}>
          <SharingAddresses />
        </Disclosure>
      ) : null}

      <InviteChooser
        visible={choosing}
        onClose={() => setChoosing(false)}
        onPerson={() => {
          setChoosing(false);
          setInviting(true);
        }}
        onServer={() => {
          setChoosing(false);
          router.push("/settings/groups/create");
        }}
      />

      {/* The address field is on this screen, so "set up a domain" unfolds it rather than pushing a
          second copy of the screen somebody is already looking at. */}
      <InvitePerson
        visible={inviting}
        onClose={() => setInviting(false)}
        onSetUpAddress={openAddress}
      />
    </PageContainer>
  );
}

/** One row of the People list: an account on this server, or an invitation nobody has opened. */
interface PersonEntry {
  key: string;
  name: string;
  state: "active" | "disabled" | "pending";
  user?: UserDto;
  invite?: InviteSummary;
}

/**
 * One person.
 *
 * An account says what it can watch, which is the only thing anybody comes to this screen to check.
 * `EnableAllFolders` is the case worth naming rather than listing: an administrator sees
 * everything, and a row reading "Movies, TV, Shared Movies…" would bury that.
 */
const PersonRow: React.FC<{ person: PersonEntry; onPress: () => void }> = ({
  person,
  onPress,
}) => {
  const { t } = useTranslation();

  const subtitle = person.invite
    ? person.invite.libraries.map((l) => l.name).join(", ")
    : person.user?.Policy?.EnableAllFolders
      ? t("sharing.person_all_libraries")
      : (person.user?.Policy?.EnabledFolders?.length ?? 0) > 0
        ? t("sharing.person_library_count", {
            count: person.user?.Policy?.EnabledFolders?.length ?? 0,
          })
        : t("sharing.person_no_libraries");

  return (
    <ListItem
      testID='sharing-person'
      title={person.name}
      subtitle={subtitle}
      showArrow
      onPress={onPress}
      iconAfter={
        <Pill
          label={t(`sharing.person_${person.state}`)}
          tone={person.state === "active" ? "success" : "neutral"}
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
 *
 * **It stopped being a router.** Answering "someone to watch" used to navigate to a screen whose
 * primary button asked the same thing again — Dan: *"I click invite -> Someone to watch -> and then
 * have to click invite again which is done."* Now the answer opens the form.
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
