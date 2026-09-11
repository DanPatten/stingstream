/**
 * Where the picture is coming from, on the OSD rather than buried in a diagnostics overlay.
 *
 * The mesh is the thing that makes this app different from every other Jellyfin client, and until
 * now the only place it was visible during playback was a line of text inside the technical-info
 * panel — a panel a user has no reason to ever open. The pill says the same thing in the corner of
 * the player, and is the way into "Play from…".
 *
 * **Nothing renders for ordinary playback.** `useMeshSourceStatus` returns `null` for a source that
 * is not a mesh URL, and a badge over every local movie would be noise that trains people to ignore
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
import { radius, rgba, space } from "@/constants/theme";
import type { SourceChoice } from "@/lib/stingstream/sourceChooser";
import {
  type MeshConnectionKind,
  useMeshSourceStatus,
} from "@/providers/MeshProvider";
import { scaleSize } from "@/utils/scaleSize";
import { PLAYER_PALETTE } from "./constants";

/**
 * Green is "these bytes came straight off the holder's disk"; amber is "working, but through more
 * hops than it needs"; grey is "no measurement yet". White is the home node proxying, which is not
 * a mesh grade at all — this device is not in the group, so there is nothing to grade.
 *
 * The same scale `TechnicalInfoOverlay` draws its diagnostic line on, deliberately: two different
 * colors for one fact is how a user learns to trust neither.
 */
export const meshDotColor = (kind: MeshConnectionKind): string => {
  // The dark palette on every theme: this pill is drawn over video, where a
  // light theme's ink would be unreadable. See PLAYER_PALETTE below.
  switch (kind) {
    case "direct":
      return PLAYER_PALETTE.state.success;
    case "relayed":
      return PLAYER_PALETTE.state.warning;
    case "home-node":
      return PLAYER_PALETTE.text.primary;
    default:
      return PLAYER_PALETTE.text.tertiary;
  }
};

interface SourcePillProps {
  mediaSource?: MediaSourceInfo | null;
  /**
   * The chooser's row for what is playing.
   *
   * Load-bearing, not decoration. `useMeshSourceStatus` can only grade a hop **this device** made,
   * and a browser, a phone and a television are not mesh members — the home node is, and it
   * proxies. So on every surface a person actually watches on, the mesh has nothing to say beyond
   * "via your server", while the node's own scored source list knows perfectly well that these
   * bytes are coming from Attic PC over a direct hop measured at five milliseconds. That is the
   * sentence the pill exists to say, so it comes from here when the mesh cannot say it.
   */
  choice?: SourceChoice | null;
  /** Opens the chooser. Absent when there is nothing else to play from. */
  onPress?: () => void;
}

/** The dot for a local file: white, the same "not a mesh grade" color the home node gets. */
const LOCAL_KIND: MeshConnectionKind = "home-node";

/** The route a choice reports, in the vocabulary the mesh status already uses. */
const kindForChoice = (choice: SourceChoice): MeshConnectionKind => {
  if (choice.local) return "home-node";
  if (choice.route === "direct") return "direct";
  if (choice.route === "relayed") return "relayed";
  return "connecting";
};

/** `Direct · Kitchen · 18 ms`, with whichever thirds are actually known. */
const pillLabel = (
  label: string,
  nodeName: string | null,
  rttMs: number | null,
): string => {
  const parts = [label];
  if (nodeName) parts.push(nodeName);
  if (rttMs != null) parts.push(`${Math.round(rttMs)} ms`);
  return parts.join(" · ");
};

/** The three route words, memoised so the content hook's dependency stays stable. */
const useRouteLabels = () => {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      direct: t("player.source.direct"),
      relayed: t("player.source.relayed"),
      connecting: t("player.source.connecting"),
    }),
    [t],
  );
};

/**
 * What the pill says and what color its dot is, from the two sources of truth in priority order:
 * this device's own measured hop first, the node's scored list second.
 */
const usePillContent = (
  status: ReturnType<typeof useMeshSourceStatus>,
  choice: SourceChoice | null | undefined,
  routeLabels: Record<"direct" | "relayed" | "connecting", string>,
  localLabel: string,
  viaServerLabel: string,
): { kind: MeshConnectionKind; label: string } =>
  useMemo(() => {
    // This device is in the group and measured the hop itself: nothing beats that.
    if (status && status.kind !== "home-node") {
      return {
        kind: status.kind,
        label: pillLabel(status.label, status.nodeName, status.rttMs),
      };
    }

    if (choice && !choice.local) {
      return {
        kind: kindForChoice(choice),
        label: pillLabel(
          routeLabels[choice.route === "local" ? "direct" : choice.route],
          choice.nodeName,
          choice.rttMs,
        ),
      };
    }

    // A mesh URL whose holder nothing can name — the sources call failed, or the pointer is
    // stale. "Via your server" is still true, and still more than the old silence.
    if (status) {
      return {
        kind: status.kind,
        label: pillLabel(viaServerLabel, status.nodeName, status.rttMs),
      };
    }

    // No mesh URL at all: the copy on the server this device is signed in to.
    return { kind: LOCAL_KIND, label: localLabel };
  }, [status, choice, routeLabels, localLabel, viaServerLabel]);

export const SourcePill: FC<SourcePillProps> = ({
  mediaSource,
  choice,
  onPress,
}) => {
  const status = useMeshSourceStatus(mediaSource);
  const { t } = useTranslation();
  const routeLabels = useRouteLabels();
  const { kind, label } = usePillContent(
    status,
    choice,
    routeLabels,
    t("player.source.this_server"),
    t("player.source.via_your_server"),
  );

  if (!status && !onPress) return null;

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
 * Focus is a **white** ring, never the accent — `docs/conventions/tv.md`. The dot keeps its color
 * because it is information, not a focus affordance.
 */
export const TVSourcePill: FC<TVSourcePillProps> = ({
  mediaSource,
  choice,
  onPress,
  refSetter,
  focusable = true,
}) => {
  const status = useMeshSourceStatus(mediaSource);
  const { t } = useTranslation();
  const typography = useScaledTVTypography();
  const routeLabels = useRouteLabels();
  const { kind, label } = usePillContent(
    status,
    choice,
    routeLabels,
    t("player.source.this_server"),
    t("player.source.via_your_server"),
  );
  const { focused, handleFocus, handleBlur, animatedStyle } =
    useTVFocusAnimation({ scaleAmount: 1.05, duration: 150 });

  if (!status && !onPress) return null;

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
        <View style={[tvStyles.dot, { backgroundColor: meshDotColor(kind) }]} />
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
    paddingHorizontal: space["2"],
    paddingVertical: space["1"],
    borderRadius: radius.pill,
    // Over video, so the chip carries its own contrast rather than relying on the scrim, which
    // fades out with the rest of the controls.
    backgroundColor: rgba(PLAYER_PALETTE.bg["0"], 0.6),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PLAYER_PALETTE.border.subtle,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: radius.pill,
    marginRight: space["2"],
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
