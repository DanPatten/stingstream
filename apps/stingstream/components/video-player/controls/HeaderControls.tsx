import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import type {
  BaseItemDto,
  MediaSourceInfo,
} from "@jellyfin/sdk/lib/generated-client";
import { type FC, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, TouchableOpacity, View } from "react-native";
import { Text } from "@/components/common/Text";
import useRouter from "@/hooks/useAppRouter";
import { useControlsSafeAreaInsets } from "@/hooks/useControlsSafeAreaInsets";
import { useHaptic } from "@/hooks/useHaptic";
import { useOrientation } from "@/hooks/useOrientation";
import type { SourceChoice } from "@/lib/stingstream/sourceChooser";
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
  /** The chooser's row for that source: where the pill gets the holder's name and latency. */
  sourceChoice?: SourceChoice | null;
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

/** `The Bear · S1E3` above the title, or the year for a movie. */
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
 * Laid out with inline styles rather than `className`.
 *
 * NativeWind v2's classes are compiled for the native runtime; in the exported web bundle they
 * reach the DOM as plain strings with no stylesheet behind them, so a `flex-row` there is a
 * silent no-op and every cluster in this bar stacks into a column. That is a foundation-level
 * problem for the whole app, but the OSD cannot wait for it: it is drawn over video, where "the
 * controls are in the wrong place" is not a cosmetic complaint.
 */
const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    padding: HEADER_LAYOUT.CONTAINER_PADDING,
  },
  left: {
    flexDirection: "row",
    alignItems: "flex-start",
    flexShrink: 1,
    marginRight: 8,
  },
  identity: {
    flexDirection: "column",
    flexShrink: 1,
    marginLeft: 4,
    paddingTop: 4,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
  },
  iconButton: {
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    padding: 8,
    marginLeft: 4,
  },
  pillSlot: {
    marginTop: 4,
  },
});

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
  sourceChoice,
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
        styles.bar,
        { top: insets.top, left: insets.left, right: insets.right },
      ]}
      pointerEvents={showControls ? "auto" : "none"}
    >
      <View style={styles.left} pointerEvents='box-none'>
        <TouchableOpacity
          onPress={onClose}
          style={[styles.iconButton, { marginLeft: 0 }]}
          accessibilityRole='button'
          accessibilityLabel={t("player.go_back")}
        >
          <Ionicons
            name='chevron-back'
            size={ICON_SIZES.HEADER}
            color='white'
          />
        </TouchableOpacity>
        <View style={styles.identity}>
          {subtitle ? (
            <Text variant='caption' tone='secondary' numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
          <Text variant='heading' weight='semibold' numberOfLines={1}>
            {item?.Name}
          </Text>
          <View style={styles.pillSlot}>
            <SourcePill
              mediaSource={mediaSource}
              choice={sourceChoice}
              onPress={onOpenSourceChooser}
            />
          </View>
        </View>
      </View>

      <View style={styles.right}>
        {/* Rotate toggle is Android-only: iOS does not reliably rotate the
            player back to portrait programmatically. */}
        {Platform.OS === "android" && !Platform.isTV && (
          <TouchableOpacity
            onPress={toggleOrientation}
            disabled={isTogglingOrientation}
            style={styles.iconButton}
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
            style={styles.iconButton}
            accessibilityRole='button'
            accessibilityLabel={t("player.picture_in_picture")}
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
            style={styles.iconButton}
            accessibilityRole='button'
            accessibilityLabel={t("player.episodes")}
          >
            <Ionicons name='list' size={ICON_SIZES.HEADER} color='white' />
          </TouchableOpacity>
        )}
        {previousItem && (
          <TouchableOpacity
            onPress={goToPreviousItem}
            style={styles.iconButton}
            accessibilityRole='button'
            accessibilityLabel={t("player.previous_item")}
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
            style={styles.iconButton}
            accessibilityRole='button'
            accessibilityLabel={t("player.next_item")}
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
            style={styles.iconButton}
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
            style={styles.iconButton}
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
