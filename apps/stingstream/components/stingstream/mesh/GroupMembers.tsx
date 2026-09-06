import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import { Loader } from "@/components/Loader";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import {
  ageOf,
  canRemoveMember,
  confirmedAction,
  type MemberRow,
  type MeshNodePeer,
  type MeshRotation,
  memberRoster,
  useNodeMeshMembers,
  useRemoveMeshMember,
  useRotateGroupSecret,
} from "@/lib/stingstream/mesh";
import { confirmDestructive } from "../shared/confirm";

/**
 * Who is in a group, and — for an administrator on a phone or the web — the two ways to change it.
 *
 * The list itself is the **home node's** view, because that is the node holding connections to
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
 * of a fresh invite. That is why each one is behind a confirmation that says so in those words,
 * why the screen shows what it is waiting for rather than a frozen button, and why the result
 * reports how many members actually took the new secret instead of claiming they all did.
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
    ? nameOf(removingRow)
    : remove.variables
      ? shorten(remove.variables.node)
      : "";

  const onRemove = useCallback(
    (row: MemberRow) => {
      void (async () => {
        try {
          const rotation = await confirmedAction<MeshRotation>({
            allowed: canRemoveMember(row, manageable),
            confirm: () =>
              confirmDestructive(
                t("home.settings.groups.remove_member_title", {
                  name: nameOf(row),
                }),
                t("home.settings.groups.remove_member_warning", {
                  name: nameOf(row),
                  group: groupName || group,
                }),
                t("home.settings.groups.remove_member_confirm"),
              ),
            act: () => remove.mutateAsync({ group, node: row.node }),
          });
          if (rotation) {
            toast.success(
              t("home.settings.groups.member_removed_result", {
                name: nameOf(row),
                n: rotation.reached.length,
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
              t("home.settings.groups.rotate_secret_title", {
                group: groupName || group,
              }),
              t("home.settings.groups.rotate_secret_warning"),
              t("home.settings.groups.rotate_secret_confirm"),
            ),
          act: () => rotate.mutateAsync(group),
        });
        if (rotation) {
          toast.success(
            t("home.settings.groups.rotate_secret_result", {
              n: rotation.reached.length,
            }),
          );
        }
      } catch (error) {
        toast.error((error as Error).message);
      }
    })();
  }, [group, groupName, manageable, rotate, t]);

  /** The state word on the right of a row. */
  const stateOf = (row: MemberRow): string => {
    if (row.isSelf) return t("home.settings.groups.member_this_node");
    if (row.revoked) return t("home.settings.groups.member_removed");
    if (!row.online) return t("home.settings.groups.member_offline");
    switch (row.path) {
      case "direct":
      case "mixed":
        return t("home.settings.groups.member_path_direct");
      case "relay":
        return t("home.settings.groups.member_path_relayed");
      default:
        return t("home.settings.groups.member_online");
    }
  };

  /** When a member was last heard from. Only worth saying about one that is not here now. */
  const lastSeenOf = (row: MemberRow): string | null => {
    if (row.online) return null;
    const age = ageOf(row.lastSeen);
    if (!age) return t("home.settings.groups.member_never_seen");
    return age.token
      ? t("home.settings.groups.member_last_seen", { when: age.token })
      : t("home.settings.groups.member_last_seen_on", {
          date: onDate(age.at),
        });
  };

  const describe = (row: MemberRow): string =>
    [
      // Last seen is an administrator's question — it is on the elevated roster and nowhere else —
      // so it stays off the list everybody else sees, which is the one a television shows.
      manageable ? lastSeenOf(row) : null,
      row.rttMs != null ? `${row.rttMs} ms` : null,
      row.freeSpace ? `${gib(row.freeSpace)} free` : null,
      shorten(row.node),
    ]
      .filter(Boolean)
      .join(" • ");

  const secretLine = useMemo(() => {
    if (!members.data) return null;
    const { epoch, rotatedAt } = members.data;
    const age = ageOf(rotatedAt);
    if (!age) {
      return t("home.settings.groups.secret_never_rotated", { epoch });
    }
    return age.token
      ? t("home.settings.groups.secret_rotated", { when: age.token, epoch })
      : t("home.settings.groups.secret_rotated_on", {
          date: onDate(age.at),
          epoch,
        });
  }, [members.data, t]);

  return (
    <>
      <ListGroup
        title={t("home.settings.groups.members_title")}
        description={
          <Text className='text-[#9899A1] text-xs'>
            {t("home.settings.groups.members_hint")}
          </Text>
        }
      >
        {rows.map((row) => {
          const removable = canRemoveMember(row, manageable);
          return (
            <ListItem
              key={row.node}
              title={nameOf(row)}
              subtitle={describe(row)}
              subtitleColor={row.online && !row.revoked ? "default" : "red"}
              value={stateOf(row)}
              // The row is the button, the way every other removable row in this app works
              // (`IndexersSection`); the confirmation is what makes a stray tap harmless.
              onPress={removable ? () => onRemove(row) : undefined}
              disabled={busy}
            >
              {removable ? (
                <Text className='text-red-600'>
                  {t("home.settings.groups.remove_member")}
                </Text>
              ) : null}
            </ListItem>
          );
        })}
        {rows.length === 0 && (
          <ListItem
            title={t("home.settings.groups.members_empty_title")}
            subtitle={t("home.settings.groups.members_empty_hint")}
          />
        )}
      </ListGroup>

      {/* Everything below is elevated on the node, so a non-administrator — and a television, where
          management screens do not go — is offered none of it. */}
      {manageable && (
        <>
          {/* A node too old to serve the roster, or one whose mesh is asleep, still shows the peer
              list above; this says why the rest of the section is thinner than it should be. */}
          {members.error != null && (
            <Text className='text-red-500 text-xs mt-2 px-1'>
              {t("home.settings.groups.members_unavailable", {
                message:
                  members.error instanceof Error
                    ? members.error.message
                    : String(members.error),
              })}
            </Text>
          )}

          {busy && (
            <View className='mt-3 rounded-xl bg-neutral-900 p-4 flex-row items-center'>
              <Loader />
              <Text className='text-[#9899A1] text-xs ml-3 flex-1'>
                {remove.isPending
                  ? t("home.settings.groups.removing_member", {
                      name: removingName,
                    })
                  : t("home.settings.groups.rotating_secret")}
              </Text>
            </View>
          )}

          {secretLine && (
            <Text className='text-[#9899A1] text-xs mt-3 px-1'>
              {secretLine}
            </Text>
          )}

          <View className='h-2' />

          <Button
            color='red'
            variant='border'
            onPress={onRotate}
            loading={rotate.isPending}
            disabled={busy}
          >
            {t("home.settings.groups.rotate_secret")}
          </Button>
        </>
      )}
    </>
  );
}

const shorten = (nodeId: string): string =>
  nodeId.length > 16 ? `${nodeId.slice(0, 12)}…` : nodeId;

/** A member's name, or a readable piece of its node id until it has said what it is called. */
const nameOf = (row: Pick<MemberRow, "node" | "nodeName">): string =>
  row.nodeName || shorten(row.node);

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(0)} GB`;

/** The absolute fallback for a moment too old for "2d ago" to mean anything useful. */
const onDate = (at: number): string =>
  new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
