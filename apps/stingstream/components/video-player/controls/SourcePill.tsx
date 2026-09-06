/**
 * Where the picture is coming from, on the OSD rather than buried in a diagnostics overlay.
 *
 * The mesh is the thing that makes this app different from every other Jellyfin client, and until
 * now the only place it was visible during playback was a line of text inside the technical-info
 * panel — a panel a user has no reason to ever open. The pill says the same thing in the corner of
 * the player, and is the way into "Play from…".
 *
 * **Nothing renders for ordinary playback.** `useMeshSourceStatus` returns `null` for a source that
 * is not a mesh URL, and a badge over every local film would be noise that trains people to ignore
 * the badge, which is the one time it matters.
 *
 * The exception is the one case where silence would be a dead end: the local copy of a title other
 * servers also hold. There is no mesh status to report, but the pill is the only way into
 * "Play from…", and a player that cannot offer the other holders while sitting on the slowest copy
 * is worse than a slightly busier corner. So the pill appears whenever a chooser exists — which is
 * exactly when `onPress` is passed — and says where the bytes are coming from: this server.
 */

import type { MediaSourceInfo } from "@jellyfin/sdk/lib/generated-client";
import { type FC, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Platform,
  Pressable,
  Animated as RNAnimated,
  type View as RNView,
  StyleSheet,
  View,
} from "react-native";
import { Text } from "@/components/common/Text";
import { useTVFocusAnimation } from "@/components/tv/hooks/useTVFocusAnimation";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { radius, rgba, tokens } from "@/constants/theme";
import {
  type MeshConnectionKind,
  useMeshSourceStatus,
} from "@/providers/MeshProvider";
import { scaleSize } from "@/utils/scaleSize";

/**
 * Green is "these bytes came straight off the holder's disk"; amber is "working, but through more
 * hops than it needs"; grey is "no measurement yet". White is the home node proxying, which is not
 * a mesh grade at all — this device is not in the group, so there is nothing to grade.
 *
 * The same scale `TechnicalInfoOverlay` draws its diagnostic line on, deliberately: two different
 * colours for one fact is how a user learns to trust neither.
 */
export const meshDotColor = (kind: MeshConnectionKind): string => {
  switch (kind) {
    case "direct":
      return tokens.color.state.success;
    case "relayed":
      return tokens.color.state.warning;
    case "home-node":
      return tokens.color.text.primary;
    default:
      return tokens.color.text.tertiary;
  }
};

interface SourcePillProps {
  mediaSource?: MediaSourceInfo | null;
  /** Opens the chooser. Absent when there is nothing else to play from. */
  onPress?: () => void;
}

/** The dot for a local file: white, the same "not a mesh grade" colour the home node gets. */
const LOCAL_KIND: MeshConnectionKind = "home-node";

/** `Direct · Kitchen · 18 ms`, with whichever halves the mesh actually knows. */
const usePillLabel = (
  status: ReturnType<typeof useMeshSourceStatus>,
): string => {
  return useMemo(() => {
    if (!status) return "";
    const parts = [status.label];
    if (status.nodeName) parts.push(status.nodeName);
    if (status.rttMs != null) parts.push(`${Math.round(status.rttMs)} ms`);
    return parts.join(" · ");
  }, [status]);
};

export const SourcePill: FC<SourcePillProps> = ({ mediaSource, onPress }) => {
  const status = useMeshSourceStatus(mediaSource);
  const { t } = useTranslation();
  const meshLabel = usePillLabel(status);

  if (!status && !onPress) return null;

  const kind = status?.kind ?? LOCAL_KIND;
  const label = status ? meshLabel : t("player.source.this_server");

  const body = (
    <View style={styles.pill}>
      <View style={[styles.dot, { backgroundColor: meshDotColor(kind) }]} />
      <Text variant='caption' weight='medium' numberOfLines={1}>
        {label}
      </Text>
    </View>
  );

  if (!onPress) {
    return (
      <View testID='player-source-pill' accessibilityRole='text'>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      testID='player-source-pill'
      onPress={onPress}
      accessibilityRole='button'
      accessibilityLabel={t("player.source.play_from")}
      accessibilityHint={label}
      hitSlop={8}
      // A pill is a small target for a mouse; the pointer is the only thing that says it is one.
      style={({ pressed }) => [
        Platform.OS === "web" ? ({ cursor: "pointer" } as never) : null,
        pressed ? { opacity: 0.7 } : null,
      ]}
    >
      {body}
    </Pressable>
  );
};

interface TVSourcePillProps extends SourcePillProps {
  /** Focus-guide plumbing: the OSD needs a handle on this to route the D-pad to it. */
  refSetter?: (ref: RNView | null) => void;
  focusable?: boolean;
}

/**
 * The television variant: same content, reachable with the D-pad.
 *
 * Focus is a **white** ring, never the accent — `docs/conventions/tv.md`. The dot keeps its colour
 * because it is information, not a focus affordance.
 */
export const TVSourcePill: FC<TVSourcePillProps> = ({
  mediaSource,
  onPress,
  refSetter,
  focusable = true,
}) => {
  const status = useMeshSourceStatus(mediaSource);
  const { t } = useTranslation();
  const typography = useScaledTVTypography();
  const meshLabel = usePillLabel(status);
  const { focused, handleFocus, handleBlur, animatedStyle } =
    useTVFocusAnimation({ scaleAmount: 1.05, duration: 150 });

  if (!status && !onPress) return null;

  const kind = status?.kind ?? LOCAL_KIND;
  const label = status ? meshLabel : t("player.source.this_server");

  return (
    <Pressable
      ref={refSetter}
      testID='player-source-pill'
      onPress={onPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      focusable={focusable && !!onPress}
      accessibilityRole='button'
      accessibilityLabel={t("player.source.play_from")}
    >
      <RNAnimated.View
        style={[
          animatedStyle,
          tvStyles.pill,
          focused ? tvStyles.focused : null,
        ]}
      >
        <View
          style={[tvStyles.dot, { backgroundColor: meshDotColor(kind) }]}
        />
        <Text style={[tvStyles.label, { fontSize: typography.callout }]}>
          {label}
        </Text>
      </RNAnimated.View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingHorizontal: tokens.space["2"],
    paddingVertical: tokens.space["1"],
    borderRadius: radius.pill,
    // Over video, so the chip carries its own contrast rather than relying on the scrim, which
    // fades out with the rest of the controls.
    backgroundColor: rgba(tokens.color.bg["0"], 0.6),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.color.border.subtle,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: radius.pill,
    marginRight: tokens.space["2"],
  },
});

const tvStyles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingHorizontal: scaleSize(12),
    paddingVertical: scaleSize(6),
    borderRadius: scaleSize(999),
    backgroundColor: "rgba(0,0,0,0.6)",
    borderWidth: scaleSize(2),
    // Transparent rather than absent so gaining focus does not resize the pill.
    borderColor: "transparent",
  },
  focused: {
    borderColor: "#fff",
  },
  dot: {
    width: scaleSize(10),
    height: scaleSize(10),
    borderRadius: scaleSize(999),
    marginRight: scaleSize(10),
  },
  label: {
    color: "#fff",
  },
});
