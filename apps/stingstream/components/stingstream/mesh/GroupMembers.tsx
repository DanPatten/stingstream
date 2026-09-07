import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { SectionHeader } from "@/components/common/SectionHeader";
import { Text } from "@/components/common/Text";
import { Loader } from "@/components/Loader";
import { radius, tokens } from "@/constants/theme";
import {
  ageOf,
  canRemoveMember,
  confirmedAction,
  type MemberRow,
  type MeshNodePeer,
  type MeshRotation,
  memberDisplayName,
  memberRoster,
  useNodeMeshMembers,
  useRemoveMeshMember,
  useRotateGroupSecret,
} from "@/lib/stingstream/mesh";
import { confirmDestructive } from "../shared/confirm";
import { MemberCard } from "./MemberCard";

/**
 * Who is in a group, and — for an administrator on a phone or the web — the two ways to change it.
 *
 * The list itself is the **server's** view, because that is the node holding connections to
 * everyone, and it is built from two endpoints rather than one. `/mesh/peers` is the measurement:
 * online, direct or relayed, round trip, free space, and any account may read it. The roster proper
 * is `/mesh/groups/{group}/members`, which is elevated and is the only source that knows which row
 * is this node and which rows belong to members that have been removed. So a member who cannot
 * manage the group sees exactly what they saw before — the peer list, unchanged — and one who can
 * sees the same rows with the membership folded in.
 *
 * **Removing and rotating are irreversible and slow.** Both mint a new group secret and hand it to
 * every member in turn, which invalidates every invite code already handed out and can take
 * minutes; a removal additionally refuses the removed node from that moment on, with no undo short
 * of a fresh invite. That is why each one is behind `confirmDestructive`, why the screen shows what
 * it is waiting for rather than a frozen button, and why the result reports how many members
 * actually took the new secret instead of claiming they all did.
 */
export function GroupMembers({
  group,
  groupName,
  peers,
  manageable,
}: {
  group: string;
  groupName: string;
  peers: readonly MeshNodePeer[] | undefined;
  /** `canManageMembers(isAdmin, Platform.isTV)`, decided by the screen above. */
  manageable: boolean;
}) {
  const { t } = useTranslation();
  // Passing null when the group cannot be managed disables the query outright, so a
  // non-administrator never fires a request that would come back 403 — and a television never
  // fires one at all, management being phone/web-only across this app.
  const members = useNodeMeshMembers(manageable ? group : null);
  const remove = useRemoveMeshMember();
  const rotate = useRotateGroupSecret();

  const rows = useMemo(
    () => memberRoster(members.data?.members, peers),
    [members.data, peers],
  );

  const busy = remove.isPending || rotate.isPending;

  // Which member the pending removal is about. Taken from the mutation's own variables rather than
  // a second piece of state, so it cannot drift out of step with whether the call is still running.
  const removingRow = remove.variables
    ? rows.find((r) => r.node === remove.variables?.node)
    : undefined;
  const removingName = removingRow
    ? memberDisplayName(removingRow)
    : remove.variables
      ? memberDisplayName({ node: remove.variables.node, nodeName: "" })
      : "";

  const onRemove = useCallback(
    (row: MemberRow) => {
      void (async () => {
        try {
          const rotation = await confirmedAction<MeshRotation>({
            allowed: canRemoveMember(row, manageable),
            confirm: () =>
              confirmDestructive(
                t("sharing.remove_member_title", {
                  name: memberDisplayName(row),
                }),
                t("sharing.remove_member_warning", {
                  name: memberDisplayName(row),
                  group: groupName || group,
                }),
                t("sharing.remove_member_confirm"),
              ),
            act: () => remove.mutateAsync({ group, node: row.node }),
          });
          if (rotation) {
            toast.success(
              t("sharing.member_removed_result", {
                name: memberDisplayName(row),
                count: rotation.reached.length,
              }),
            );
          }
        } catch (error) {
          toast.error((error as Error).message);
        }
      })();
    },
    [group, groupName, manageable, remove, t],
  );

  const onRotate = useCallback(() => {
    void (async () => {
      try {
        const rotation = await confirmedAction<MeshRotation>({
          allowed: manageable,
          confirm: () =>
            confirmDestructive(
              t("sharing.rotate_secret_title", {
                group: groupName || group,
              }),
              t("sharing.rotate_secret_warning"),
              t("sharing.rotate_secret_confirm"),
            ),
          act: () => rotate.mutateAsync(group),
        });
        if (rotation) {
          toast.success(
            t("sharing.rotate_secret_result", {
              count: rotation.reached.length,
            }),
          );
        }
      } catch (error) {
        toast.error((error as Error).message);
      }
    })();
  }, [group, groupName, manageable, rotate, t]);

  const secretLine = useMemo(() => {
    if (!members.data) return null;
    const { epoch, rotatedAt } = members.data;
    const age = ageOf(rotatedAt);
    if (!age) {
      return t("sharing.secret_never_rotated", { epoch });
    }
    return age.token
      ? t("sharing.secret_rotated", { when: age.token, epoch })
      : t("sharing.secret_rotated_on", { date: onDate(age.at), epoch });
  }, [members.data, t]);

  return (
    <View>
      <SectionHeader title={t("sharing.members_title")} />
      <Text
        variant='caption'
        tone='secondary'
        style={{ paddingHorizontal: 4, marginBottom: 12, marginTop: -4 }}
      >
        {t("sharing.members_hint")}
      </Text>

      {rows.map((row) => (
        <MemberCard
          key={row.node}
          row={row}
          name={memberDisplayName(row)}
          removable={canRemoveMember(row, manageable)}
          onRemove={() => onRemove(row)}
          disabled={busy}
        />
      ))}
      {rows.length === 0 && (
        <View
          style={{
            padding: 16,
            borderRadius: radius.md,
            backgroundColor: tokens.color.bg["1"],
          }}
        >
          <Text variant='body' weight='semibold'>
            {t("sharing.members_empty_title")}
          </Text>
          <Text variant='caption' tone='secondary' style={{ marginTop: 2 }}>
            {t("sharing.members_empty_hint")}
          </Text>
        </View>
      )}

      {/* Everything below is elevated on the server, so a non-administrator — and a television,
          where management screens do not go — is offered none of it. */}
      {manageable && (
        <>
          {/* A server too old to serve the roster, or one whose mesh is asleep, still shows the
              peer list above; this says why the rest of the section is thinner than it should be. */}
          {members.error != null && (
            <Text
              variant='caption'
              tone='danger'
              style={{ marginTop: 8, paddingHorizontal: 4 }}
            >
              {t("sharing.members_unavailable", {
                message:
                  members.error instanceof Error
                    ? members.error.message
                    : String(members.error),
              })}
            </Text>
          )}

          {busy && (
            <View
              style={{
                marginTop: 12,
                borderRadius: radius.md,
                backgroundColor: tokens.color.bg["1"],
                padding: 14,
                flexDirection: "row",
                alignItems: "center",
              }}
            >
              <Loader />
              <Text
                variant='caption'
                tone='secondary'
                style={{ marginLeft: 12, flex: 1 }}
              >
                {remove.isPending
                  ? t("sharing.removing_member", { name: removingName })
                  : t("sharing.rotating_secret")}
              </Text>
            </View>
          )}

          {secretLine && (
            <Text
              variant='caption'
              tone='secondary'
              style={{ marginTop: 12, paddingHorizontal: 4 }}
            >
              {secretLine}
            </Text>
          )}

          <View style={{ height: 8 }} />

          <Button
            variant='danger'
            onPress={onRotate}
            loading={rotate.isPending}
            disabled={busy}
          >
            {t("sharing.rotate_secret")}
          </Button>
        </>
      )}
    </View>
  );
}

/** The absolute fallback for a moment too old for "2d ago" to mean anything useful. */
const onDate = (at: number): string =>
  new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
