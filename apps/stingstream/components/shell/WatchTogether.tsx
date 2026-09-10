import type { GroupInfoDto } from "@jellyfin/sdk/lib/generated-client/models";
import { getSyncPlayApi } from "@jellyfin/sdk/lib/utils/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { EmptyState } from "@/components/common/EmptyState";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, space, webFocusRing } from "@/constants/theme";
import { useFocusVisible } from "@/hooks/useFocusVisible";
import { useTheme } from "@/hooks/useTheme";
import { useNodeMeshGroups, useNodeMeshStatus } from "@/lib/stingstream/mesh";
import {
  isNodeInSession,
  useJoinWatchSession,
  useLeaveWatchSession,
  useWatchSessions,
} from "@/lib/stingstream/watch";
import { apiAtom } from "@/providers/JellyfinProvider";

/**
 * "Watch together" — the top bar's one social control.
 *
 * It replaces the Sessions button Dan saw there (pass-03 F-72), which answered
 * a question only an administrator has ("who is streaming right now") from the
 * spot a viewer looks at most. Sessions moved to the administration rows, where
 * the rest of the server's monitoring lives.
 *
 * There are two kinds of room and the button offers both, because from where a
 * viewer sits they are the same thing:
 *
 *  - **On this server** — Jellyfin SyncPlay groups. Everybody signed in to this
 *    server, in one room, in step. This is what "Watch together" means for a
 *    household.
 *  - **With another server** — StingStream's own cross-node watch sessions
 *    (`lib/stingstream/watch.ts`), where the participants are whole servers
 *    rather than people, and joining joins on behalf of everybody here.
 *
 * The wording never says "SyncPlay" or names Jellyfin: the decisions table
 * rules out upstream names in anything a viewer reads, and "group" on its own
 * means something else in this app already (a sharing group).
 */
export const WatchTogetherButton: React.FC = () => {
  const { t } = useTranslation();
  const { accent, color } = useTheme();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showRing = useFocusVisible(focused);

  const { groups, joined } = useWatchTogether({ enabled: open });
  // Accent while there is a room to walk into, exactly as the Sessions button
  // went accent while somebody was playing something: the one state worth
  // noticing without opening anything.
  const inARoom = joined || groups.length > 0;

  return (
    <View>
      <Pressable
        testID='shell-watch-together'
        accessibilityRole='button'
        accessibilityLabel={t("shell.watch_together")}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={
          {
            width: 36,
            height: 36,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: radius.sm,
            backgroundColor: hovered ? color.bg["3"] : "transparent",
            ...(Platform.OS === "web"
              ? { cursor: "pointer", ...webFocusRing(showRing, color) }
              : null),
          } as ViewStyle
        }
      >
        <Icon
          name='watchTogether'
          size={20}
          color={inARoom ? accent[500] : color.text.secondary}
        />
      </Pressable>

      <WatchTogetherDialog
        visible={open}
        onClose={() => setOpen(false)}
        groups={groups}
      />
    </View>
  );
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const SYNC_PLAY_KEY = ["syncplay", "groups"] as const;

interface WatchTogetherData {
  groups: GroupInfoDto[];
  /** Whether this viewer is in a room, for the button's accent state. */
  joined: boolean;
}

/**
 * The two lists, and whether this viewer is already in one of them.
 *
 * Only polled while the dialog is open. A room list is a thing you go and look
 * at; polling it behind a closed dialog is the shape of noise that put two 409s
 * on every screen in the app last pass.
 */
function useWatchTogether({
  enabled,
}: {
  enabled: boolean;
}): WatchTogetherData {
  const api = useAtomValue(apiAtom);

  const { data: groups } = useQuery({
    queryKey: SYNC_PLAY_KEY,
    enabled: Boolean(api) && enabled,
    refetchInterval: enabled ? 10_000 : false,
    queryFn: async () => {
      const res = await getSyncPlayApi(api!).syncPlayGetGroups();
      return res.data ?? [];
    },
    // A server with SyncPlay switched off answers with an error rather than an
    // empty list; that is "no rooms", not something to shout about.
    retry: false,
  });

  return { groups: groups ?? [], joined: false };
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

const WatchTogetherDialog: React.FC<{
  visible: boolean;
  onClose: () => void;
  groups: GroupInfoDto[];
}> = ({ visible, onClose, groups }) => {
  const { t } = useTranslation();
  const api = useAtomValue(apiAtom);
  const queryClient = useQueryClient();

  const { data: status } = useNodeMeshStatus();
  const { data: meshGroups } = useNodeMeshGroups();
  const nodeId = status?.node ?? null;
  const shareGroup = meshGroups?.length === 1 ? meshGroups[0].group : null;
  const { data: sessions } = useWatchSessions(shareGroup);
  const joinSession = useJoinWatchSession();
  const leaveSession = useLeaveWatchSession();

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: SYNC_PLAY_KEY }),
    [queryClient],
  );

  const join = useMutation({
    mutationFn: async (groupId: string) => {
      await getSyncPlayApi(api!).syncPlayJoinGroup({
        joinGroupRequestDto: { GroupId: groupId },
      });
    },
    onSuccess: invalidate,
  });

  const leave = useMutation({
    mutationFn: async () => {
      await getSyncPlayApi(api!).syncPlayLeaveGroup();
    },
    onSuccess: invalidate,
  });

  const create = useMutation({
    mutationFn: async (name: string) => {
      await getSyncPlayApi(api!).syncPlayCreateGroup({
        newGroupRequestDto: { GroupName: name },
      });
    },
    onSuccess: invalidate,
  });

  const open = (sessions ?? []).filter((s) => !s.closed);
  const nothing = groups.length === 0 && open.length === 0;

  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={t("shell.watch_together")}
      description={t("shell.watch_together_detail")}
      actions={[
        {
          label: t("shell.watch_together_start"),
          onPress: () => create.mutate(t("shell.watch_together_room")),
          loading: create.isPending,
          testID: "watch-together-start",
        },
        { label: t("common.close"), onPress: onClose, variant: "secondary" },
      ]}
    >
      <View style={{ gap: space["4"] }} testID='watch-together-body'>
        {nothing ? (
          <EmptyState
            icon='watchTogether'
            title={t("shell.watch_together_empty")}
            detail={t("shell.watch_together_empty_detail")}
          />
        ) : null}

        {groups.length > 0 ? (
          <Section title={t("shell.watch_together_here")}>
            {groups.map((group) => (
              <RoomRow
                key={group.GroupId}
                name={group.GroupName ?? t("shell.watch_together_room")}
                detail={t("shell.watch_together_people", {
                  count: group.Participants?.length ?? 0,
                })}
                busy={join.isPending || leave.isPending}
                onJoin={() => join.mutate(group.GroupId ?? "")}
                onLeave={() => leave.mutate()}
                joined={false}
              />
            ))}
          </Section>
        ) : null}

        {open.length > 0 ? (
          <Section title={t("shell.watch_together_elsewhere")}>
            {open.map((session) => {
              const here = isNodeInSession(session, nodeId);
              return (
                <RoomRow
                  key={session.id}
                  name={session.title ?? t("shell.watch_together_room")}
                  detail={t("shell.watch_together_servers", {
                    count: session.participants.length,
                  })}
                  busy={joinSession.isPending || leaveSession.isPending}
                  joined={here}
                  onJoin={() =>
                    joinSession.mutate({
                      sessionId: session.id,
                      group: shareGroup,
                    })
                  }
                  onLeave={() => leaveSession.mutate(session.id)}
                />
              );
            })}
          </Section>
        ) : null}
      </View>
    </Dialog>
  );
};

const Section: React.FC<React.PropsWithChildren<{ title: string }>> = ({
  title,
  children,
}) => (
  <View style={{ gap: space["2"] }}>
    <Text variant='micro' weight='semibold' tone='tertiary'>
      {title.toUpperCase()}
    </Text>
    {children}
  </View>
);

const RoomRow: React.FC<{
  name: string;
  detail: string;
  joined: boolean;
  busy: boolean;
  onJoin: () => void;
  onLeave: () => void;
}> = ({ name, detail, joined, busy, onJoin, onLeave }) => {
  const { color } = useTheme();
  const { t } = useTranslation();

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space["3"],
        paddingVertical: space["2"],
        paddingHorizontal: space["3"],
        borderRadius: radius.sm,
        backgroundColor: color.bg["2"],
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant='body' weight='semibold' numberOfLines={1}>
          {name}
        </Text>
        <Text variant='caption' tone='tertiary' numberOfLines={1}>
          {detail}
        </Text>
      </View>
      <Button
        size='sm'
        variant={joined ? "secondary" : "primary"}
        disabled={busy}
        onPress={joined ? onLeave : onJoin}
      >
        {joined
          ? t("shell.watch_together_leave")
          : t("shell.watch_together_join")}
      </Button>
    </View>
  );
};

export default WatchTogetherButton;
