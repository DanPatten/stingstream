import type { Api } from "@jellyfin/sdk";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import type React from "react";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import {
  cancelAnimation,
  Easing,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Icon } from "@/components/common/Icon";
import { Image } from "@/components/common/ServerImage";
import { Text } from "@/components/common/Text";
import { radius, rgba, tokens } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { getPrimaryImageUrl } from "@/utils/jellyfin/image/getPrimaryImageUrl";
import { CountdownRing } from "./CountdownRing";
import { CONTROLS_CONSTANTS } from "./constants";

interface NextEpisodeCountDownButtonProps {
  onFinish?: () => void;
  onPress?: () => void;
  show: boolean;
  // When false, the card is shown as a plain tap target with no ring animation
  // and never auto-advances — used when the trigger that revealed it (e.g.
  // credits-segment metadata) isn't reliable enough to act on without the user
  // confirming.
  autoAdvance?: boolean;
  /** Media time left in the current item, in milliseconds. */
  remainingMs: number;
  isPlaying: boolean;
  /** Id of the item being played, to scope the countdown to it. */
  itemId?: string | null;
  /** The episode being counted down to — the card's thumbnail and title. */
  nextItem?: BaseItemDto | null;
  api?: Api | null;
}

/** Media time the ring represents, matching the window the card appears in. */
const COUNTDOWN_WINDOW_MS = CONTROLS_CONSTANTS.NEXT_EPISODE_COUNTDOWN_MS;
/**
 * The player reports its position about once a second, so the last sample of
 * an item can sit that far short of the end. Anything inside this window is
 * the end of the item.
 */
const END_OF_ITEM_MS = 1000;
/** One position sample: the interval a single ring step has to cover. */
const SAMPLE_MS = 1000;

const RING_SIZE = 44;

/** `S1E3 · The Title`, or just the title when the numbering is missing. */
export const nextUpLabel = (item: BaseItemDto | null | undefined): string => {
  if (!item) return "";
  const code =
    item.ParentIndexNumber != null && item.IndexNumber != null
      ? `S${item.ParentIndexNumber}E${item.IndexNumber}`
      : null;
  return [code, item.Name].filter(Boolean).join(" · ");
};

/**
 * "Next up" on phone and web: a thumbnail, what is coming, and a ring that runs out.
 *
 * The predecessor was a 128 px pill reading "Next episode" with a bar sweeping across it — no
 * indication of *which* episode, and a fill that read as progress rather than as a countdown. This
 * is the same card the television shows, at phone scale.
 */
const NextEpisodeCountDownButton: React.FC<NextEpisodeCountDownButtonProps> = ({
  onFinish,
  onPress,
  show,
  autoAdvance = true,
  remainingMs,
  isPlaying,
  itemId,
  nextItem,
  api = null,
}) => {
  const { t } = useTranslation();
  const { accent } = useTheme();
  const progress = useSharedValue(0);
  // Advancing is one-way per appearance: without this, any re-render inside
  // the end-of-item window would navigate again.
  const hasAdvancedRef = useRef(false);
  // The remaining time is only trustworthy once the player has reported a
  // position for the item on screen. Until then it still describes the
  // previous episode, which reads as "one second left" the moment the next one
  // starts and would chain through a whole season. Advancing waits for a
  // sample that is clearly not the end.
  const hasSeenItemRunningRef = useRef(false);
  const countedItemRef = useRef(itemId);

  // Fill from the item's own clock rather than from a countdown of its own.
  // A timer has to be told about everything that happens to playback: it
  // drifts as soon as the speed is not 1x, keeps running while playback is
  // paused, and ignores seeks. The remaining time already covers all three.
  const target =
    show && autoAdvance
      ? Math.min(Math.max(1 - remainingMs / COUNTDOWN_WINDOW_MS, 0), 1)
      : 0;

  useEffect(() => {
    if (!show) {
      cancelAnimation(progress);
      progress.value = 0;
      hasAdvancedRef.current = false;
      return;
    }

    // Pausing freezes the ring where it stands. Without cancelling, the tween
    // already in flight would keep creeping for up to a sample after playback
    // stopped.
    if (!isPlaying) {
      cancelAnimation(progress);
      return;
    }

    // Reach for the next sample instead of jumping to it, so the ring moves
    // smoothly between two position reports. Paused playback stops moving the
    // target, which leaves the ring where it is instead of emptying it.
    progress.value = withTiming(target, {
      duration: SAMPLE_MS,
      easing: Easing.linear,
    });

    // Cancel on unmount so nothing keeps animating after the player is gone.
    return () => {
      cancelAnimation(progress);
    };
  }, [show, target, progress, isPlaying]);

  useEffect(() => {
    if (countedItemRef.current !== itemId) {
      countedItemRef.current = itemId;
      // An in-place episode switch keeps this mounted with `show` still true,
      // so without emptying the ring the new item would inherit the old one's
      // while its first media-clock sample is still the outgoing episode's.
      cancelAnimation(progress);
      progress.value = 0;
      hasSeenItemRunningRef.current = false;
      hasAdvancedRef.current = false;
    }
    if (remainingMs > END_OF_ITEM_MS) hasSeenItemRunningRef.current = true;

    if (!show || !autoAdvance || !onFinish) return;
    if (hasAdvancedRef.current || !hasSeenItemRunningRef.current) return;
    // Android keeps the player open at the end of a file, so it pauses itself
    // there instead of reporting a position past the end. Treat a pause inside
    // the last sample as the end of the item, and keep the plain check for
    // players that do report past the item's duration.
    const reachedEnd = remainingMs <= 0;
    const stoppedAtEnd = !isPlaying && remainingMs <= END_OF_ITEM_MS;
    if (!reachedEnd && !stoppedAtEnd) return;
    hasAdvancedRef.current = true;
    onFinish();
  }, [show, autoAdvance, remainingMs, isPlaying, itemId, onFinish, progress]);

  const imageUrl = useMemo(
    () =>
      nextItem
        ? getPrimaryImageUrl({ api, item: nextItem, width: 320, quality: 80 })
        : null,
    [api, nextItem],
  );

  const label = nextUpLabel(nextItem);

  if (!show) {
    return null;
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole='button'
      accessibilityLabel={`${t("player.next_up")}${label ? `: ${label}` : ""}`}
      style={({ pressed }) => [
        styles.card,
        pressed ? { opacity: 0.85 } : null,
        Platform.OS === "web" ? ({ cursor: "pointer" } as never) : null,
      ]}
    >
      {imageUrl ? (
        <Image source={{ uri: imageUrl }} style={styles.thumbnail} />
      ) : null}
      <View style={styles.body}>
        <Text variant='micro' tone='tertiary' style={styles.kicker}>
          {t("player.next_up")}
        </Text>
        <Text variant='body' weight='semibold' numberOfLines={1}>
          {label || t("player.next_episode")}
        </Text>
      </View>
      <CountdownRing
        progress={progress}
        size={RING_SIZE}
        strokeWidth={3}
        color={accent[500]}
        trackColor={rgba("#FFFFFF", 0.25)}
      >
        <Icon name='play' size={16} tone='primary' />
      </CountdownRing>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: 340,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: rgba(tokens.color.bg["0"], 0.82),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.color.border.subtle,
    paddingRight: 12,
  },
  thumbnail: {
    width: 84,
    height: 48,
    backgroundColor: tokens.color.bg["2"],
  },
  body: {
    flexShrink: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  kicker: {
    textTransform: "uppercase",
    letterSpacing: 1,
  },
});

export default NextEpisodeCountDownButton;
