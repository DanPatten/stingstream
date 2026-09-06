import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import type {
  BaseItemDto,
  MediaSourceInfo,
} from "@jellyfin/sdk/lib/generated-client";
import { type FC, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, TouchableOpacity, View } from "react-native";
import { Text } from "@/components/common/Text";
import useRouter from "@/hooks/useAppRouter";
import { useControlsSafeAreaInsets } from "@/hooks/useControlsSafeAreaInsets";
import { useHaptic } from "@/hooks/useHaptic";
import { useOrientation } from "@/hooks/useOrientation";
import { OrientationLock } from "@/packages/expo-screen-orientation";
import {
  onFullscreenChange,
  isFullscreen as readFullscreen,
  toggleFullscreen,
} from "@/utils/web/fullscreen";
import { HEADER_LAYOUT, ICON_SIZES } from "./constants";
import DropdownView from "./dropdown/DropdownView";
import { SourcePill } from "./SourcePill";
import { PlaybackSpeedScope } from "./utils/playback-speed-settings";
import { shouldShowPlayerMenu } from "./utils/shouldShowPlayerMenu";
import { type AspectRatio } from "./VideoScalingModeSelector";
import { ZoomToggle } from "./ZoomToggle";

interface HeaderControlsProps {
  item: BaseItemDto;
  showControls: boolean;
  startPictureInPicture?: () => Promise<void>;
  switchOnEpisodeMode: () => void;
  goToPreviousItem: () => void;
  goToNextItem: (options: { isAutoPlay?: boolean }) => void;
  previousItem?: BaseItemDto | null;
  nextItem?: BaseItemDto | null;
  aspectRatio?: AspectRatio;
  isZoomedToFill?: boolean;
  onZoomToggle?: () => void;
  /** The source playing, so the pill can say how its bytes are arriving. */
  mediaSource?: MediaSourceInfo | null;
  /** Opens "Play from…". Absent when there is nothing else to play this from. */
  onOpenSourceChooser?: () => void;
  /** Web only: the page is the mixer, so muting needs a control and an indicator. */
  isMuted?: boolean;
  onToggleMute?: () => void;
  // Playback speed props
  playbackSpeed?: number;
  setPlaybackSpeed?: (speed: number, scope: PlaybackSpeedScope) => void;
  subtitleDelay?: number;
  onSubtitleDelayChange?: (seconds: number) => void;
  // Technical info props
  showTechnicalInfo?: boolean;
  onToggleTechnicalInfo?: () => void;
  onOpenSubtitleScale?: () => void;
}

/** `The Bear · S1E3` above the title, or the year for a film. */
const subtitleFor = (item: BaseItemDto): string | null => {
  if (item?.Type === "Episode") {
    const code =
      item.ParentIndexNumber != null && item.IndexNumber != null
        ? `S${item.ParentIndexNumber}E${item.IndexNumber}`
        : null;
    return [item.SeriesName, code].filter(Boolean).join(" · ") || null;
  }
  if (item?.Type === "Movie" && item.ProductionYear) {
    return String(item.ProductionYear);
  }
  if (item?.Type === "Audio" && item.Album) return item.Album;
  return null;
};

const isWeb = Platform.OS === "web" && !Platform.isTV;

/**
 * The top of the OSD: what you are watching and where it came from on the left, what you can do to
 * it on the right.
 *
 * The title used to live at the *bottom*, above the seek bar, which is where a phone player from
 * 2016 put it. Every player people actually reach for now — Plex, Netflix, YouTube's theatre mode —
 * puts identity top-left and controls top-right, and the source pill only makes sense next to the
 * title it qualifies.
 */
export const HeaderControls: FC<HeaderControlsProps> = ({
  item,
  showControls,
  startPictureInPicture,
  switchOnEpisodeMode,
  goToPreviousItem,
  goToNextItem,
  previousItem,
  nextItem,
  aspectRatio: _aspectRatio = "default",
  isZoomedToFill = false,
  onZoomToggle,
  mediaSource,
  onOpenSourceChooser,
  isMuted = false,
  onToggleMute,
  playbackSpeed = 1.0,
  setPlaybackSpeed,
  subtitleDelay = 0,
  onSubtitleDelayChange,
  showTechnicalInfo = false,
  onToggleTechnicalInfo,
  onOpenSubtitleScale,
}) => {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useControlsSafeAreaInsets();
  const lightHapticFeedback = useHaptic("light");
  const { orientation, lockOrientation } = useOrientation();
  const [isTogglingOrientation, setIsTogglingOrientation] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // F11, Escape and the browser's own exit button all change this without asking us, so the icon
  // follows the document rather than our own presses.
  useEffect(() => {
    if (!isWeb) return;
    setFullscreen(readFullscreen());
    return onFullscreenChange(setFullscreen);
  }, []);

  const onClose = async () => {
    lightHapticFeedback();
    router.back();
  };

  const toggleOrientation = useCallback(async () => {
    if (isTogglingOrientation) return;

    setIsTogglingOrientation(true);
    lightHapticFeedback();

    try {
      const isPortrait =
        orientation === OrientationLock.PORTRAIT_UP ||
        orientation === OrientationLock.PORTRAIT_DOWN;

      await lockOrientation(
        isPortrait ? OrientationLock.LANDSCAPE : OrientationLock.PORTRAIT_UP,
      );
    } finally {
      setIsTogglingOrientation(false);
    }
  }, [
    orientation,
    lockOrientation,
    isTogglingOrientation,
    lightHapticFeedback,
  ]);

  // Deliberately fullscreens the document rather than the player element: React Native Web renders
  // dialogs and sheets through a portal at the body, and those would be invisible inside a
  // fullscreened subtree — which is exactly when the chooser gets opened.
  const onToggleFullscreen = useCallback(() => {
    void toggleFullscreen(null);
  }, []);

  const subtitle = subtitleFor(item);

  return (
    <View
      style={[
        {
          position: "absolute",
          top: insets.top,
          left: insets.left,
          right: insets.right,
          padding: HEADER_LAYOUT.CONTAINER_PADDING,
        },
      ]}
      pointerEvents={showControls ? "auto" : "none"}
      className='flex flex-row justify-between items-start'
    >
      <View
        className='flex flex-row items-start shrink mr-2'
        pointerEvents='box-none'
      >
        <TouchableOpacity
          onPress={onClose}
          className='aspect-square flex flex-col rounded-xl items-center justify-center p-2'
          accessibilityRole='button'
          accessibilityLabel={t("player.go_back")}
        >
          <Ionicons
            name='chevron-back'
            size={ICON_SIZES.HEADER}
            color='white'
          />
        </TouchableOpacity>
        <View className='flex flex-col shrink ml-1 pt-1'>
          {subtitle ? (
            <Text variant='caption' tone='secondary' numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
          <Text variant='heading' weight='semibold' numberOfLines={1}>
            {item?.Name}
          </Text>
          <View className='mt-1'>
            <SourcePill
              mediaSource={mediaSource}
              onPress={onOpenSourceChooser}
            />
          </View>
        </View>
      </View>

      <View className='flex flex-row items-center space-x-2 shrink-0'>
        {/* Rotate toggle is Android-only: iOS does not reliably rotate the
            player back to portrait programmatically. */}
        {Platform.OS === "android" && !Platform.isTV && (
          <TouchableOpacity
            onPress={toggleOrientation}
            disabled={isTogglingOrientation}
            className='aspect-square flex flex-col rounded-xl items-center justify-center p-2'
            accessibilityLabel={t("accessibility.toggle_orientation")}
            accessibilityHint={t("accessibility.toggle_orientation_hint")}
          >
            <MaterialIcons
              name='screen-rotation'
              size={ICON_SIZES.HEADER}
              color='white'
              style={{ opacity: isTogglingOrientation ? 0.5 : 1 }}
            />
          </TouchableOpacity>
        )}
        {!Platform.isTV && startPictureInPicture && (
          <TouchableOpacity
            onPress={startPictureInPicture}
            className='aspect-square flex flex-col rounded-xl items-center justify-center p-2'
          >
            <MaterialIcons
              name='picture-in-picture'
              size={ICON_SIZES.HEADER}
              color='white'
            />
          </TouchableOpacity>
        )}
        {item?.Type === "Episode" && (
          <TouchableOpacity
            onPress={switchOnEpisodeMode}
            className='aspect-square flex flex-col rounded-xl items-center justify-center p-2'
          >
            <Ionicons name='list' size={ICON_SIZES.HEADER} color='white' />
          </TouchableOpacity>
        )}
        {previousItem && (
          <TouchableOpacity
            onPress={goToPreviousItem}
            className='aspect-square flex flex-col rounded-xl items-center justify-center p-2'
          >
            <Ionicons
              name='play-skip-back'
              size={ICON_SIZES.HEADER}
              color='white'
            />
          </TouchableOpacity>
        )}
        {nextItem && (
          <TouchableOpacity
            onPress={() => goToNextItem({ isAutoPlay: false })}
            className='aspect-square flex flex-col rounded-xl items-center justify-center p-2'
          >
            <Ionicons
              name='play-skip-forward'
              size={ICON_SIZES.HEADER}
              color='white'
            />
          </TouchableOpacity>
        )}
        {/* MPV Zoom Toggle */}
        <ZoomToggle
          isZoomedToFill={isZoomedToFill}
          onToggle={onZoomToggle ?? (() => {})}
          disabled={!onZoomToggle}
        />
        {/* On a phone or a television the volume keys are the volume control. In a browser window
            there are none, so `m` needs something to point at. */}
        {isWeb && onToggleMute && (
          <TouchableOpacity
            onPress={onToggleMute}
            className='aspect-square flex flex-col rounded-xl items-center justify-center p-2'
            accessibilityRole='button'
            accessibilityLabel={isMuted ? t("player.unmute") : t("player.mute")}
          >
            <Ionicons
              name={isMuted ? "volume-mute" : "volume-medium"}
              size={ICON_SIZES.HEADER}
              color='white'
            />
          </TouchableOpacity>
        )}
        {isWeb && (
          <TouchableOpacity
            testID='player-fullscreen'
            onPress={onToggleFullscreen}
            className='aspect-square flex flex-col rounded-xl items-center justify-center p-2'
            accessibilityRole='button'
            accessibilityLabel={
              fullscreen ? t("player.exit_fullscreen") : t("player.fullscreen")
            }
          >
            <Ionicons
              name={fullscreen ? "contract" : "expand"}
              size={ICON_SIZES.HEADER}
              color='white'
            />
          </TouchableOpacity>
        )}
        {shouldShowPlayerMenu({ isTV: Platform.isTV }) && (
          <View pointerEvents='auto'>
            <DropdownView
              playbackSpeed={playbackSpeed}
              setPlaybackSpeed={setPlaybackSpeed}
              subtitleDelay={subtitleDelay}
              onSubtitleDelayChange={onSubtitleDelayChange}
              showTechnicalInfo={showTechnicalInfo}
              onToggleTechnicalInfo={onToggleTechnicalInfo}
              onOpenSubtitleScale={onOpenSubtitleScale}
            />
          </View>
        )}
      </View>
    </View>
  );
};
