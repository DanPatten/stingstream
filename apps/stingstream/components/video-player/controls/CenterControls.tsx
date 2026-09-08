import { Ionicons } from "@expo/vector-icons";
import type { FC } from "react";
import { useTranslation } from "react-i18next";
import { Platform, TouchableOpacity, View } from "react-native";
import { Text } from "@/components/common/Text";
import { Loader } from "@/components/Loader";
import { useControlsSafeAreaInsets } from "@/hooks/useControlsSafeAreaInsets";
import { useSettings } from "@/utils/atoms/settings";
import AudioSlider from "./AudioSlider";
import BrightnessSlider from "./BrightnessSlider";
import { ICON_SIZES } from "./constants";

/**
 * Whether this surface has a screen and a speaker of its own to turn up.
 *
 * The brightness slider is `expo-brightness` and the volume slider is
 * `react-native-volume-manager`: both drive the *device*, and a browser has no such thing. On the
 * web the first threw on its first call and logged a warning for it, and the second rendered a
 * 130 px slider rotated ninety degrees against the right edge — which, being a volume glyph on its
 * side, read as a stray wifi icon floating in the middle of the picture with nothing to press
 * (F-51). The page's own volume is what the header's mute button and the `m` key are for.
 */
const hasDeviceHardwareControls = Platform.OS !== "web";

interface CenterControlsProps {
  showControls: boolean;
  isPlaying: boolean;
  isBuffering: boolean;
  showAudioSlider: boolean;
  setShowAudioSlider: (show: boolean) => void;
  togglePlay: () => void;
  handleSkipBackward: () => void;
  handleSkipForward: () => void;
  // Chapter navigation props
  hasChapters?: boolean;
  hasPreviousChapter?: boolean;
  hasNextChapter?: boolean;
  goToPreviousChapter?: () => void;
  goToNextChapter?: () => void;
}

export const CenterControls: FC<CenterControlsProps> = ({
  showControls,
  isPlaying,
  isBuffering,
  showAudioSlider,
  setShowAudioSlider,
  togglePlay,
  handleSkipBackward,
  handleSkipForward,
  hasChapters = false,
  hasPreviousChapter = false,
  hasNextChapter = false,
  goToPreviousChapter,
  goToNextChapter,
}) => {
  const { settings } = useSettings();
  const insets = useControlsSafeAreaInsets();
  const { t } = useTranslation();

  return (
    <View
      style={{
        position: "absolute",
        top: "50%",
        left: insets.left,
        right: insets.right,
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        transform: [{ translateY: -22.5 }],
        paddingHorizontal: hasChapters ? "18%" : "28%",
      }}
      pointerEvents={showControls ? "box-none" : "none"}
    >
      {hasDeviceHardwareControls && !settings?.hideBrightnessSlider && (
        <View
          style={{
            position: "absolute",
            alignItems: "center",
            transform: [{ rotate: "270deg" }],
            left: 0,
            bottom: 30,
          }}
        >
          <BrightnessSlider />
        </View>
      )}

      {!Platform.isTV && (
        <TouchableOpacity
          onPress={handleSkipBackward}
          accessibilityRole='button'
          accessibilityLabel={t("player.skip_back_seconds", {
            seconds: settings?.rewindSkipTime,
          })}
        >
          <View
            style={{
              position: "relative",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Ionicons
              name='refresh-outline'
              size={ICON_SIZES.CENTER}
              color='white'
              style={{
                transform: [{ scaleY: -1 }, { rotate: "180deg" }],
              }}
            />
            <Text
              style={{
                position: "absolute",
                color: "white",
                fontSize: 16,
                fontWeight: "bold",
                bottom: 10,
              }}
            >
              {settings?.rewindSkipTime}
            </Text>
          </View>
        </TouchableOpacity>
      )}

      {!Platform.isTV && hasChapters && (
        <TouchableOpacity
          onPress={goToPreviousChapter}
          disabled={!hasPreviousChapter}
          style={{ opacity: hasPreviousChapter ? 1 : 0.3 }}
          accessibilityRole='button'
          accessibilityLabel={t("player.previous_chapter")}
        >
          <Ionicons
            name='play-back'
            size={ICON_SIZES.CENTER - 10}
            color='white'
          />
        </TouchableOpacity>
      )}

      <View style={Platform.isTV ? { flex: 1, alignItems: "center" } : {}}>
        <TouchableOpacity
          onPress={togglePlay}
          accessibilityRole='button'
          accessibilityLabel={isPlaying ? t("player.pause") : t("player.play")}
        >
          {!isBuffering ? (
            <Ionicons
              name={isPlaying ? "pause" : "play"}
              size={ICON_SIZES.CENTER}
              color='white'
            />
          ) : (
            <Loader size={"large"} />
          )}
        </TouchableOpacity>
      </View>

      {!Platform.isTV && hasChapters && (
        <TouchableOpacity
          onPress={goToNextChapter}
          disabled={!hasNextChapter}
          style={{ opacity: hasNextChapter ? 1 : 0.3 }}
          accessibilityRole='button'
          accessibilityLabel={t("player.next_chapter")}
        >
          <Ionicons
            name='play-forward'
            size={ICON_SIZES.CENTER - 10}
            color='white'
          />
        </TouchableOpacity>
      )}

      {!Platform.isTV && (
        <TouchableOpacity
          onPress={handleSkipForward}
          accessibilityRole='button'
          accessibilityLabel={t("player.skip_forward_seconds", {
            seconds: settings?.forwardSkipTime,
          })}
        >
          <View
            style={{
              position: "relative",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Ionicons
              name='refresh-outline'
              size={ICON_SIZES.CENTER}
              color='white'
            />
            <Text
              style={{
                position: "absolute",
                color: "white",
                fontSize: 16,
                fontWeight: "bold",
                bottom: 10,
              }}
            >
              {settings?.forwardSkipTime}
            </Text>
          </View>
        </TouchableOpacity>
      )}

      {hasDeviceHardwareControls && !settings?.hideVolumeSlider && (
        <View
          style={{
            position: "absolute",
            alignItems: "center",
            transform: [{ rotate: "270deg" }],
            bottom: 30,
            right: 0,
            opacity: showAudioSlider || showControls ? 1 : 0,
          }}
        >
          <AudioSlider setVisibility={setShowAudioSlider} />
        </View>
      )}
    </View>
  );
};
