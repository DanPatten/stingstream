import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Dialog, type DialogAction } from "@/components/common/Dialog";
import { Image } from "@/components/common/ServerImage";
import { Text } from "@/components/common/Text";
import { radius, space } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  type CastUnavailableReason,
  webCastSession,
} from "@/lib/cast/webCastSession";
import { formatTimeString } from "@/utils/time";

/**
 * The two dialogs casting needs in a browser.
 *
 * On a phone, `CastContext.showExpandedControls()` opens the Cast SDK's own
 * full-screen controller, and a device with no Play Services gets the SDK's own
 * error dialog. A browser has neither, so the web build of
 * `react-native-google-cast` opens these instead: the controls for what is
 * playing, and a dialog that says why casting cannot start here.
 *
 * Mounted once by each web shell (`WebShellLayout`, `MobileShell`), so every
 * caller gets the same dialogs.
 */
export const CastControlsSheet: React.FC = () =>
  Platform.OS === "web" ? (
    <>
      <WebCastControls />
      <CastUnavailableDialog />
    </>
  ) : null;

const useCastSnapshot = () =>
  useSyncExternalStore(
    webCastSession.subscribe,
    webCastSession.getSnapshot,
    webCastSession.getSnapshot,
  );

const WebCastControls: React.FC = () => {
  const { t } = useTranslation();
  const { accent, color } = useTheme();
  const snapshot = useCastSnapshot();
  const [trackWidth, setTrackWidth] = useState(0);

  const status = snapshot.mediaStatus;
  const close = () => webCastSession.setControlsOpen(false);
  const duration = status?.mediaInfo?.streamDuration ?? 0;
  const position = status?.streamPosition ?? 0;
  const paused = status?.playerState === "paused";
  const image = status?.mediaInfo?.metadata?.images?.[0]?.url;
  const title = status?.mediaInfo?.metadata?.title;
  const played = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <Dialog
      // Also closes by itself when the receiver stops, rather than showing controls for nothing.
      visible={snapshot.controlsOpen && status != null}
      onClose={close}
      title={t("shell.cast_casting_to", { device: snapshot.deviceName ?? "" })}
      actions={[
        {
          label: paused ? t("player.play") : t("player.pause"),
          icon: paused ? "play" : "pause",
          onPress: () =>
            void (paused
              ? webCastSession.client.play()
              : webCastSession.client.pause()),
          testID: "cast-play-pause",
        },
        {
          label: t("shell.cast_stop"),
          variant: "secondary",
          onPress: () => void webCastSession.endSession(true),
          testID: "cast-stop",
        },
      ]}
    >
      <View style={{ gap: space["4"] }} testID='cast-controls'>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space["3"],
          }}
        >
          {image ? (
            <Image
              source={{ uri: image }}
              contentFit='cover'
              style={{
                width: 56,
                height: 84,
                borderRadius: radius.sm,
                backgroundColor: color.bg["2"],
              }}
            />
          ) : null}
          <Text
            variant='heading'
            weight='semibold'
            numberOfLines={2}
            style={{ flex: 1 }}
          >
            {title}
          </Text>
        </View>

        <View style={{ gap: space["2"] }}>
          <Pressable
            testID='cast-seek'
            onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
            onPress={(e) => {
              if (!duration || !trackWidth) return;
              const ratio = Math.min(
                1,
                Math.max(0, e.nativeEvent.locationX / trackWidth),
              );
              void webCastSession.client.seek({ position: ratio * duration });
            }}
            style={
              {
                height: 24,
                justifyContent: "center",
                ...(Platform.OS === "web" ? { cursor: "pointer" } : null),
              } as ViewStyle
            }
          >
            <View
              style={{
                height: 4,
                borderRadius: 2,
                overflow: "hidden",
                backgroundColor: color.border.strong,
              }}
            >
              <View
                style={{
                  width: `${played}%`,
                  height: "100%",
                  backgroundColor: accent[500],
                }}
              />
            </View>
          </Pressable>
          <View
            style={{ flexDirection: "row", justifyContent: "space-between" }}
          >
            <Text variant='caption' tone='secondary'>
              {formatTimeString(position, "s")}
            </Text>
            <Text variant='caption' tone='secondary'>
              {formatTimeString(duration, "s")}
            </Text>
          </View>
        </View>
      </View>
    </Dialog>
  );
};

/**
 * Why casting cannot start, as a title and one line.
 *
 * Only a script that never arrived offers Try again: an insecure address or a
 * browser that cannot cast gives the same answer however often it is asked.
 */
const UNAVAILABLE_COPY = {
  insecure: {
    title: "shell.cast_unavailable_insecure_title",
    detail: "shell.cast_unavailable_insecure_detail",
  },
  unsupported: {
    title: "shell.cast_unavailable_unsupported_title",
    detail: "shell.cast_unavailable_unsupported_detail",
  },
  blocked: {
    title: "shell.cast_unavailable_blocked_title",
    detail: "shell.cast_unavailable_blocked_detail",
  },
} as const satisfies Record<
  CastUnavailableReason,
  { title: string; detail: string }
>;

const CastUnavailableDialog: React.FC = () => {
  const { t } = useTranslation();
  const snapshot = useCastSnapshot();
  const reason = snapshot.unavailableReason ?? "unsupported";
  const copy = UNAVAILABLE_COPY[reason];
  const close = () => webCastSession.dismissUnavailable();

  const actions: DialogAction[] =
    reason === "blocked"
      ? [
          {
            label: t("shell.cast_try_again"),
            onPress: () => void webCastSession.retry(),
            testID: "cast-retry",
          },
          {
            label: t("common.close"),
            variant: "secondary",
            onPress: close,
            testID: "cast-unavailable-close",
          },
        ]
      : [
          {
            label: t("common.close"),
            onPress: close,
            testID: "cast-unavailable-close",
          },
        ];

  return (
    <Dialog
      visible={snapshot.unavailableOpen}
      onClose={close}
      title={t(copy.title)}
      description={t(copy.detail)}
      actions={actions}
    />
  );
};

export default CastControlsSheet;
