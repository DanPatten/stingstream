import {
  type BaseItemDto,
  PlayCommand,
} from "@jellyfin/sdk/lib/generated-client/models";
import { getSessionApi } from "@jellyfin/sdk/lib/utils/api/session-api";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Dialog } from "@/components/common/Dialog";
import { MenuItem } from "@/components/common/Menu";
import { Text } from "@/components/common/Text";
import { useAllSessions, type useSessionsProps } from "@/hooks/useSessions";
import { apiAtom } from "@/providers/JellyfinProvider";
import { logAndCaptureError } from "@/utils/log";
import { Loader } from "./Loader";

interface Props {
  item: BaseItemDto;
  visible: boolean;
  onClose: () => void;
}

/**
 * "Play on another device": the sessions this server can send a title to.
 *
 * Opened by the details page's "..." row itself. It used to be a round badge at the end of that
 * row, which opened its own React Native `Modal` with hard-coded colours; the row and the badge
 * said the same thing twice (Dan, 2026-09-22), and the modal was outside the one modal surface.
 */
export const PlayInRemoteSessionDialog: React.FC<Props> = ({
  item,
  visible,
  onClose,
}) => {
  const { t } = useTranslation();
  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={t("home.sessions.select_session")}
    >
      {/* Its own component: on a device the dialog is presented once, with the content it had
          then, so the list has to hold its own query to stay current. */}
      <SessionList item={item} onDone={onClose} />
    </Dialog>
  );
};

const SessionList: React.FC<{ item: BaseItemDto; onDone: () => void }> = ({
  item,
  onDone,
}) => {
  const api = useAtomValue(apiAtom);
  const { t } = useTranslation();
  const { sessions, isLoading } = useAllSessions({} as useSessionsProps);

  const play = async (sessionId: string) => {
    if (!api || !item.Id) return;
    onDone();
    try {
      await getSessionApi(api).play({
        sessionId,
        itemIds: [item.Id],
        playCommand: PlayCommand.PlayNow,
      });
    } catch (error) {
      logAndCaptureError("Play in remote session failed", error);
    }
  };

  if (isLoading) {
    return (
      <View style={{ paddingVertical: 32, alignItems: "center" }}>
        <Loader />
      </View>
    );
  }

  if (!sessions?.length) {
    return (
      <Text tone='secondary' style={{ paddingVertical: 16 }}>
        {t("home.sessions.no_active_sessions")}
      </Text>
    );
  }

  return (
    <View style={{ marginHorizontal: -16 }}>
      {sessions.map((session) => (
        <MenuItem
          key={session.Id ?? session.DeviceName ?? ""}
          icon='devices'
          label={session.DeviceName ?? session.Client ?? ""}
          description={session.Client ?? undefined}
          onPress={() => void play(session.Id ?? "")}
        />
      ))}
    </View>
  );
};
