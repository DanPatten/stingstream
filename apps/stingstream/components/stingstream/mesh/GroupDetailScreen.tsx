import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { PageContainer } from "@/components/common/PageContainer";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius, tokens } from "@/constants/theme";
import {
  canManageMembers,
  MeshUnavailableError,
  useLeaveMeshGroup,
  useMeshSharingSettings,
  useNodeMeshGroups,
  useNodeMeshPeers,
  useSetGroupCoordinator,
} from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";
import { confirmDestructive } from "../shared/confirm";
import { Disclosure } from "../shared/Disclosure";
import { GapNotice } from "../shared/GapNotice";
import { useIsStingStreamAdmin } from "../shared/RequiresAdmin";
import { QueryState } from "../shared/ScreenState";
import { GroupMembers } from "./GroupMembers";
import { InviteCard } from "./InviteCard";

/**
 * One group: who is in it, how they are reached, its rendezvous server, and the way out.
 *
 * The member list is the **server's** view — it is the one that actually holds connections to
 * everyone, whereas this device only dials a member when something is playing from it. The
 * rendezvous server and the danger zone both sit behind an "Advanced" disclosure, collapsed by
 * default: changing either is rare and one of them (leaving) is irreversible, so neither belongs
 * above the fold on a screen most visits are just here to check on members.
 */
export function GroupDetailScreen({ group }: { group: string }) {
  const { t } = useTranslation();
  const groups = useNodeMeshGroups();
  const peers = useNodeMeshPeers(group);
  const leave = useLeaveMeshGroup();
  const mesh = useMesh();
  const isAdmin = useIsStingStreamAdmin();
  const [showInvite, setShowInvite] = useState(false);

  const info = useMemo(
    () => (groups.data ?? []).find((g) => g.group === group),
    [groups.data, group],
  );

  // Removing a member and rotating the secret are elevated on the server and phone/web only, and
  // the roster they are attached to is elevated too — so this one flag decides whether the member
  // list is even asked for. See `canManageMembers`.
  const manageable = canManageMembers(isAdmin, Platform.isTV);

  // The counts stay the peer list's, not the roster's: the roster keeps removed members on it so
  // the removal is visible, and counting those as members of the group would be a lie.
  const peerRows = peers.data ?? [];
  const onlineCount = peerRows.filter((p) => p.online).length;
  const groupName = info?.name ?? "";

  const onLeave = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDestructive(
        t("sharing.leave_confirm_title", { group: groupName || group }),
        t("sharing.leave_confirm_warning"),
        t("sharing.leave_confirm_button"),
      );
      if (!confirmed) return;
      try {
        await leave.mutateAsync(group);
        // The embedded node follows the server, so tell it now rather than waiting for the
        // five-minute sync to notice.
        await mesh.syncGroups();
        toast.success(
          t("sharing.leave_success", { group: groupName || group }),
        );
      } catch (error) {
        toast.error((error as Error).message);
      }
    })();
  }, [group, groupName, leave, mesh, t]);

  // A server whose mesh child is down answers 503 here, and that is not "this group has no
  // members" — it is "nothing can be asked right now", which gets its own state rather than an
  // empty member list that would read as the group having been abandoned.
  if (groups.error instanceof MeshUnavailableError) {
    return (
      <PageContainer width='settings'>
        <GapNotice
          title={t("sharing.mesh_unavailable_title")}
          detail={t("sharing.mesh_unavailable_detail")}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer width='settings'>
      <QueryState
        isLoading={groups.isLoading}
        error={groups.error}
        onRetry={groups.refetch}
      >
        <View
          style={{
            padding: 16,
            borderRadius: radius.md,
            backgroundColor: tokens.color.bg["1"],
          }}
        >
          <Text variant='title' weight='semibold'>
            {groupName || t("sharing.unnamed_group")}
          </Text>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 8,
              marginTop: 10,
            }}
          >
            <Pill
              label={t("sharing.member_count", { count: peerRows.length })}
            />
            <Pill
              tone={onlineCount > 0 ? "success" : "neutral"}
              label={t("sharing.online_count", { count: onlineCount })}
            />
            <Pill
              tone={isAdmin ? "accent" : "neutral"}
              label={
                isAdmin ? t("sharing.role_admin") : t("sharing.role_member")
              }
            />
          </View>
        </View>

        {isAdmin && (
          <>
            <View style={{ height: 16 }} />
            <Button
              testID='sharing-invite'
              variant='primary'
              icon='invite'
              onPress={() => setShowInvite(true)}
            >
              {t("sharing.invite_button")}
            </Button>
            <Dialog
              visible={showInvite}
              onClose={() => setShowInvite(false)}
              title={t("sharing.invite_dialog_title", {
                group: groupName || group,
              })}
            >
              <InviteCard group={group} groupName={groupName} />
            </Dialog>
          </>
        )}

        <View style={{ height: 20 }} />

        <GroupMembers
          group={group}
          groupName={groupName}
          peers={peers.data}
          manageable={manageable}
        />

        <View style={{ height: 20 }} />

        <Disclosure title={t("sharing.advanced_title")}>
          {isAdmin ? (
            <ChangeCoordinator
              group={group}
              current={info?.coordinator ?? null}
            />
          ) : (
            <ReadOnlyCoordinator coordinator={info?.coordinator ?? null} />
          )}

          {isAdmin && (
            <View
              style={{
                marginTop: 20,
                paddingTop: 16,
                borderTopWidth: 1,
                borderTopColor: tokens.color.border.subtle,
              }}
            >
              <Text
                variant='caption'
                weight='semibold'
                tone='danger'
                style={{ marginBottom: 8 }}
              >
                {t("sharing.danger_zone_title")}
              </Text>
              <Button
                testID='sharing-leave'
                variant='danger'
                icon='leave'
                onPress={onLeave}
                loading={leave.isPending}
              >
                {t("sharing.leave_button")}
              </Button>
            </View>
          )}
        </Disclosure>
      </QueryState>
    </PageContainer>
  );
}

/** A collapsed-by-default section — the shape "Advanced" needs and nothing else in this app has. */
/**
 * The group's sharing server: what it is, and one way to change it.
 *
 * No field and no choice. A group takes its server from the node that created it, so the only thing
 * worth offering here is "make this group use the server this node uses now" — for the case where
 * somebody has since changed that setting and wants an existing group to follow.
 *
 * The note is the point. This is not a setting on this device: it reaches every member through
 * gossip, and a member that is offline right now adopts it when it comes back.
 */
function ChangeCoordinator({
  group,
  current,
}: {
  group: string;
  current: string | null;
}) {
  const { t } = useTranslation();
  const settings = useMeshSharingSettings();
  const setCoordinator = useSetGroupCoordinator();

  const nodeServer = settings.data?.coordinatorDefault ?? null;
  const settled = settings.isSuccess || settings.isError;
  // Only offer the move when there is somewhere to move to and it is somewhere else. Everything
  // else — still loading, already matching, nothing configured — is no button at all rather than a
  // button that does nothing.
  const canFollow = settled && (nodeServer ?? null) !== (current ?? null);

  const save = async () => {
    try {
      await setCoordinator.mutateAsync({ group, coordinator: nodeServer });
      toast.success(
        nodeServer
          ? t("sharing.rendezvous_change_success", { host: hostOf(nodeServer) })
          : t("sharing.rendezvous_change_success_default"),
      );
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <View>
      <ListGroup>
        <ListItem
          title={t("sharing.group_server_label")}
          subtitle={current ? hostOf(current) : t("sharing.group_server_none")}
        />
      </ListGroup>

      {canFollow && (
        <>
          <Text variant='caption' tone='accent' style={{ marginTop: 12 }}>
            {t("sharing.group_server_differs", {
              from: current ? hostOf(current) : t("sharing.group_server_none"),
              to: nodeServer
                ? hostOf(nodeServer)
                : t("sharing.group_server_none"),
            })}
          </Text>
          <Text variant='caption' tone='secondary' style={{ marginTop: 8 }}>
            {t("sharing.rendezvous_change_note")}
          </Text>
          <View style={{ height: 12 }} />
          <Button
            variant='primary'
            disabled={setCoordinator.isPending}
            loading={setCoordinator.isPending}
            onPress={() => void save()}
          >
            {t("sharing.group_server_follow")}
          </Button>
        </>
      )}
    </View>
  );
}

function ReadOnlyCoordinator({ coordinator }: { coordinator: string | null }) {
  const { t } = useTranslation();
  return (
    <View>
      <Text variant='body' weight='semibold'>
        {t("sharing.group_server_label")}
      </Text>
      <Text variant='caption' tone='secondary' style={{ marginTop: 4 }}>
        {coordinator ? hostOf(coordinator) : t("sharing.group_server_none")}
      </Text>
    </View>
  );
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
