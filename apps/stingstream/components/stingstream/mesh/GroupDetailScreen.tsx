import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { PageContainer } from "@/components/common/PageContainer";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  canManageMembers,
  MeshUnavailableError,
  useLeaveMeshGroup,
  useNodeMeshGroups,
  useNodeMeshMembers,
  useNodeMeshPeers,
  useRemoveMeshMember,
  useSetSharedLibraries,
  useSharedLibraries,
} from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";
import { confirmDestructive } from "../shared/confirm";
import { Disclosure } from "../shared/Disclosure";
import { GapNotice } from "../shared/GapNotice";
import { LibraryPicker } from "../shared/LibraryPicker";
import { useIsStingStreamAdmin } from "../shared/RequiresAdmin";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { GroupMembers, RotateSecret } from "./GroupMembers";
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
  const { color } = useTheme();
  const { t } = useTranslation();
  const groups = useNodeMeshGroups();
  const peers = useNodeMeshPeers(group);
  const leave = useLeaveMeshGroup();
  const removeMember = useRemoveMeshMember();
  const members = useNodeMeshMembers(group);
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

  /**
   * Unlink: stop sharing, and make the other side stop too.
   *
   * **Two calls, because leaving alone is one-sided and silent.** `leave` is purely local — it
   * stops this node gossiping, drops the index and forgets the secret, and dials nobody. The other
   * server keeps this node in its peer list for ever and, more to the point, **keeps the shared
   * secret**, so every invite code ever minted for the link still works and this node could be
   * re-added without its owner doing anything.
   *
   * So the honest version rotates first — which removes the other side and re-keys what is left —
   * and only then leaves. The rotation is attempted for every member rather than only the one that
   * matters, because in a link of more than two there is no single "them".
   *
   * A rotation that cannot reach anybody is not a reason to stay: leaving still happens, and the
   * toast says the other side may not have heard yet. The alternative — refusing to unlink because
   * a peer is offline — leaves somebody unable to end a share they no longer want.
   */
  const onLeave = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDestructive(
        t("sharing.unlink_confirm_title", { group: groupName || group }),
        t("sharing.unlink_confirm_warning"),
        t("sharing.unlink_confirm_button"),
      );
      if (!confirmed) return;

      let told = true;
      try {
        // The membership list rather than the peer list: only this one knows which row is the
        // node asking the question, and the mesh refuses to revoke yourself anyway.
        const others = (members.data?.members ?? []).filter(
          (m) => !m.isSelf && !m.revoked,
        );
        for (const member of others) {
          await removeMember.mutateAsync({ group, node: member.node });
        }
      } catch {
        // Offline, or a build that refuses. Recorded so the toast can be honest about it.
        told = false;
      }

      try {
        await leave.mutateAsync(group);
        // The embedded node follows the server, so tell it now rather than waiting for the
        // five-minute sync to notice.
        await mesh.syncGroups();
        toast.success(
          t(
            told
              ? "sharing.unlink_success"
              : "sharing.unlink_success_unreached",
            {
              group: groupName || group,
            },
          ),
        );
      } catch (error) {
        toast.error((error as Error).message);
      }
    })();
  }, [group, groupName, leave, members.data, mesh, removeMember, t]);

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

  // An id that is not one of this server's links.
  //
  // `[group]` is the only dynamic segment under `settings/servers`, so it
  // catches every path that does not match a real file — and when
  // `settings/servers/create` was deleted, `/settings/servers/create` started
  // resolving *here*, rendering a management screen for a group called
  // "create": "Unnamed", nought members, and a live "Rotate secret" button.
  // Confirmed live before this guard existed.
  //
  // A stale bookmark to a link somebody has since left does exactly the same
  // thing, so this is worth having on its own account. Gated on the query
  // having actually answered: `undefined` while it is in flight is "not known
  // yet", not "not there", and the 503 above is neither.
  if (groups.isSuccess && !info) {
    return (
      <PageContainer width='settings'>
        <EmptyState
          icon='servers'
          title={t("sharing.group_not_found_title")}
          detail={t("sharing.group_not_found_detail")}
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
            backgroundColor: color.bg["1"],
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
            <View style={{ height: 20 }} />
            <SharedLibrariesSection group={group} />
          </>
        )}

        {isAdmin && (
          <>
            {/* The button moved into the Members heading, where it belongs -- inviting a server
                adds a member. A full-width primary bar between the libraries and the roster split
                the page in half and belonged to neither side of it. */}
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
          onInvite={isAdmin ? () => setShowInvite(true) : undefined}
        />

        <View style={{ height: 20 }} />

        <Disclosure title={t("sharing.advanced_title")}>
          {isAdmin && (
            <View
              style={{
                marginTop: 20,
                paddingTop: 16,
                borderTopWidth: 1,
                borderTopColor: color.border.subtle,
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
                {t("sharing.unlink_button")}
              </Button>

              {/* Beside Unlink, because it is the same kind of act: rare, slow, and impossible to
                  undo. It was a red bar in the middle of the member list. */}
              {manageable ? (
                <RotateSecret group={group} groupName={groupName} />
              ) : null}
            </View>
          )}
        </Disclosure>
      </QueryState>
    </PageContainer>
  );
}

/**
 * Which of this server's libraries the other side gets.
 *
 * Dan: *"Each side picks its own."* So this edits **your** half only. What you see of theirs is
 * their decision, made on their own server, and saying that plainly is more honest than a control
 * that looks editable and is not.
 *
 * Saved on every tap rather than behind a Save button: there is one field, the server republishes
 * immediately, and a screen that can be left half-applied is how somebody ends up believing they
 * un-shared something they did not.
 */
const SharedLibrariesSection: React.FC<{ group: string }> = ({ group }) => {
  const { t } = useTranslation();
  const libraries = useSharedLibraries(group);
  const save = useSetSharedLibraries();

  const shared = libraries.data?.shared ?? [];

  const toggle = (id: string) => {
    const next = shared.includes(id)
      ? shared.filter((existing) => existing !== id)
      : [...shared, id];
    save.mutate(
      { group, libraries: next },
      { onError: (e) => toast.error(e.message) },
    );
  };

  return (
    <View>
      <Text variant='caption' tone='secondary' weight='medium'>
        {t("sharing.link_libraries_title")}
      </Text>
      <Text variant='caption' tone='tertiary' style={{ marginBottom: 8 }}>
        {t("sharing.link_libraries_hint")}
      </Text>
      <LibraryPicker
        available={libraries.data?.available ?? []}
        selected={shared}
        onToggle={toggle}
        loading={libraries.isPending}
        disabled={save.isPending}
      />
    </View>
  );
};
