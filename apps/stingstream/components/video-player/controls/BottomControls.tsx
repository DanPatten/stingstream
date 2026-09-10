import { Ionicons } from "@expo/vector-icons";
import type { ChapterInfo } from "@jellyfin/sdk/lib/generated-client";
import { type FC, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Slider } from "react-native-awesome-slider";
import { type SharedValue } from "react-native-reanimated";
import { ChapterList } from "@/components/chapters/ChapterList";
import { ChapterTicks } from "@/components/chapters/ChapterTicks";
import { Text } from "@/components/common/Text";
import { useControlsSafeAreaInsets } from "@/hooks/useControlsSafeAreaInsets";
import { useTheme } from "@/hooks/useTheme";
import {
  chapterMarkers,
  chapterNameAt,
  hasChapterMarkers,
} from "@/utils/chapters";
import { TimeDisplay } from "./TimeDisplay";
import { TrickplayBubble } from "./TrickplayBubble";

// Chapter tick height in dp — matches the slider track height for a clean,
// flush look (no top/bottom overflow).
const TICK_HEIGHT = 10;

/**
 * The bottom bar's gutter, in dp, and why it is 12 rather than the 8 it was.
 *
 * `react-native-awesome-slider` wraps its track in a `HitSlop` that exists **only on the web**: a
 * `<div>` inset by -10 on all four sides, so a mouse can grab the bar without hitting a 10 px
 * target exactly. With an 8 px gutter that div started at x = -2 and ended 2 px past the window,
 * which is the whole of the player page's 2 px horizontal scroll (F-51) — a page that scrolls
 * sideways by two pixels, from an element nobody can see.
 *
 * So the gutter is the slider's own slop plus a little: at 12 the pointer target lands 2 px inside
 * each edge at every width. Clipping was the other option and is worse — the chapter ticks are
 * taller than the track and are *meant* to bleed out of it, and the trickplay bubble floats above
 * the bar entirely.
 */
const BAR_HORIZONTAL_PADDING = 12;

// Inline rather than `className` for the same reason HeaderControls is: NativeWind v2's classes
// are inert in the exported web bundle, and a seek bar that stacks into a column is not a seek bar.
const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    flexDirection: "column",
    paddingHorizontal: BAR_HORIZONTAL_PADDING,
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  chapterLabel: {
    flexDirection: "column",
    alignItems: "flex-start",
    flexShrink: 1,
    justifyContent: "flex-end",
  },
  actions: {
    flexDirection: "row",
    alignItems: "flex-end",
    flexShrink: 0,
    paddingRight: 8,
    paddingBottom: 4,
  },
  chapterButton: {
    justifyContent: "center",
    marginLeft: 16,
    marginBottom: 4,
  },
  sliderBlock: {
    flexDirection: "column",
    width: "100%",
    marginVertical: 8,
  },
  track: {
    height: 10,
    justifyContent: "center",
    alignItems: "stretch",
    // Chapter ticks are taller than the 10px track and must bleed out top and bottom; React
    // Native defaults to overflow "hidden" on Android.
    overflow: "visible",
  },
});

interface BottomControlsProps {
  /** Item chapters, used for the tick overlay and chapter list. */
  chapters?: ChapterInfo[] | null;
  /** Total media duration in milliseconds. */
  durationMs: number;
  showControls: boolean;
  isSliding: boolean;
  showRemoteBubble: boolean;
  currentTime: number;
  remainingTime: number;
  handleControlsInteraction: () => void;

  // Slider props
  min: SharedValue<number>;
  max: SharedValue<number>;
  effectiveProgress: SharedValue<number>;
  cacheProgress: SharedValue<number>;
  handleSliderStart: () => void;
  handleSliderComplete: (value: number) => void;
  handleSliderChange: (value: number) => void;
  handleTouchStart: () => void;
  handleTouchEnd: () => void;
  /** Programmatic seek (chapter list, hotkeys) — bypasses slide gesture state. */
  seekTo: (value: number) => void;

  // Trickplay props
  trickPlayUrl: {
    x: number;
    y: number;
    url: string;
  } | null;
  trickplayInfo: {
    aspectRatio?: number;
    data: {
      TileWidth?: number;
      TileHeight?: number;
    };
  } | null;
  time: {
    hours: number;
    minutes: number;
    seconds: number;
  };
}

export const BottomControls: FC<BottomControlsProps> = ({
  chapters,
  durationMs,
  showControls,
  isSliding,
  showRemoteBubble,
  currentTime,
  remainingTime,
  handleControlsInteraction,
  min,
  max,
  effectiveProgress,
  cacheProgress,
  handleSliderStart,
  handleSliderComplete,
  handleSliderChange,
  handleTouchStart,
  handleTouchEnd,
  seekTo,
  trickPlayUrl,
  trickplayInfo,
  time,
}) => {
  const { t } = useTranslation();
  const insets = useControlsSafeAreaInsets();
  const { accent } = useTheme();
  const [chapterListVisible, setChapterListVisible] = useState(false);

  const chapterMarkerList = useMemo(
    () => chapterMarkers(chapters, durationMs),
    [chapters, durationMs],
  );
  const hasChapters = useMemo(
    () => hasChapterMarkers(chapters, durationMs),
    [chapters, durationMs],
  );

  // Current chapter name for the always-visible header label (live playback).
  const currentChapterName = useMemo(
    () => (hasChapters ? chapterNameAt(currentTime, chapters) : null),
    [hasChapters, currentTime, chapters],
  );

  // Chapter name at the scrubbed position for the trickplay bubble. `time` is
  // an {h,m,s} object derived from the slider's dragged value — convert back
  // to ms for the lookup. Only useful while actively scrubbing.
  const scrubChapterName = useMemo(() => {
    if (!hasChapters) return null;
    const scrubMs =
      (time.hours * 3600 + time.minutes * 60 + time.seconds) * 1000;
    return chapterNameAt(scrubMs, chapters);
  }, [hasChapters, time.hours, time.minutes, time.seconds, chapters]);

  return (
    <View
      style={[
        styles.bar,
        {
          right: insets.right,
          left: insets.left,
          bottom: Math.max(insets.bottom - 17, 0),
        },
      ]}
      onTouchStart={handleControlsInteraction}
    >
      <View style={styles.topRow}>
        {/* Title, series and year moved to the top-left with the source pill (HeaderControls):
            identity belongs next to the thing that qualifies it, and the bottom bar is for the
            timeline. What is left here is the one label that describes the *position*. */}
        <View
          style={styles.chapterLabel}
          pointerEvents={showControls ? "box-none" : "none"}
        >
          {currentChapterName ? (
            <Text variant='caption' tone='secondary' numberOfLines={1}>
              {currentChapterName}
            </Text>
          ) : null}
        </View>
        <View style={styles.actions}>
          {hasChapters && (
            <Pressable
              onPress={() => setChapterListVisible(true)}
              hitSlop={10}
              style={styles.chapterButton}
              accessibilityRole='button'
              accessibilityLabel={t("chapters.open")}
            >
              <Ionicons name='bookmarks' size={24} color='white' />
            </Pressable>
          )}
        </View>
      </View>
      <View
        style={styles.sliderBlock}
        pointerEvents={showControls ? "box-none" : "none"}
      >
        <View>
          <View
            style={styles.track}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            <Slider
              theme={{
                maximumTrackTintColor: "rgba(255,255,255,0.2)",
                minimumTrackTintColor: accent[500],
                // The one place the accent belongs on the OSD: watched progress. Everything else
                // over video stays white, which is the only color that reads on any frame.
                cacheTrackTintColor: "rgba(255,255,255,0.3)",
                bubbleBackgroundColor: "#fff",
                bubbleTextColor: "#666",
                heartbeatColor: "#999",
              }}
              renderThumb={() => null}
              cache={cacheProgress}
              onSlidingStart={handleSliderStart}
              onSlidingComplete={handleSliderComplete}
              onValueChange={handleSliderChange}
              containerStyle={{
                borderRadius: 100,
              }}
              renderBubble={() =>
                (isSliding || showRemoteBubble) && (
                  <TrickplayBubble
                    trickPlayUrl={trickPlayUrl}
                    trickplayInfo={trickplayInfo}
                    time={time}
                    chapterName={scrubChapterName}
                  />
                )
              }
              sliderHeight={10}
              thumbWidth={0}
              progress={effectiveProgress}
              minimumValue={min}
              maximumValue={max}
            />
            <ChapterTicks markers={chapterMarkerList} height={TICK_HEIGHT} />
          </View>
          <TimeDisplay
            currentTime={currentTime}
            remainingTime={remainingTime}
          />
        </View>
      </View>
      <ChapterList
        visible={chapterListVisible}
        chapters={chapters}
        currentPositionMs={currentTime}
        onSeek={seekTo}
        onClose={() => setChapterListVisible(false)}
      />
    </View>
  );
};
