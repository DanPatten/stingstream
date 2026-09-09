import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { PageContainer } from "@/components/common/PageContainer";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";
import {
  canManageMembers,
  MeshUnavailableError,
  useLeaveMeshGroup,
  useNodeMeshGroups,
  useNodeMeshPeers,
  useSetSharedLibraries,
  useSharedLibraries,
} from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";
import { confirmDestructive } from "../shared/confirm";
import { Disclosure } from "../shared/Disclosure";
import { GapNotice } from "../shared/GapNotice";
import { LibraryPicker } from "../shared/LibraryPicker";
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
            <View style={{ height: 20 }} />
            <SharedLibrariesSection group={group} />
          </>
        )}

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
