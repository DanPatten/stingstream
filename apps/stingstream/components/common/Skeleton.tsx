import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  type StyleProp,
  View,
  type ViewStyle,
} from "react-native";
import type { CardKind } from "@/components/cards/CardData";
import { useCardLayout } from "@/components/cards/useCardLayout";
import { interaction, radius as RADII, tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";

export interface SkeletonProps {
  /** A number of dp, or a percentage string for a text line. */
  width?: number | `${number}%`;
  height?: number;
  /** Defaults to `sm` for blocks; pass 4 for a text line. */
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * The grey block that stands in for content while it loads.
 *
 * A spinner says "something is happening". A skeleton of the final geometry
 * says *what* is about to happen, holds the layout so nothing jumps when the
 * data lands, and makes a slow screen feel like it is filling rather than
 * stalling. The critique's rule is the short version: skeletons for content,
 * spinners only inside a pressed button.
 *
 * The pulse is opacity, not a moving gradient: a translating highlight needs a
 * masked layer per block, and on a grid of thirty cards that is thirty extra
 * animated views for an effect nobody looks at directly.
 */
export const Skeleton: React.FC<SkeletonProps> = ({
  width = "100%",
  height = 16,
  radius = RADII.sm,
  style,
}) => {
  const opacity = usePulse();

  return (
    <Animated.View
      // Announced as one "Loading" region by the containers below, not as
      // thirty separate blocks, so a screen reader is not read a wall of them.
      accessibilityElementsHidden
      importantForAccessibility='no-hide-descendants'
      style={[
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: tokens.color.bg["2"],
          opacity,
        },
        style,
      ]}
    />
  );
};

/**
 * A horizontal row of card-shaped skeletons, at the real card geometry for
 * this breakpoint — so the row does not resize when the cards arrive.
 */
export const SkeletonRow: React.FC<{
  kind: CardKind;
  count?: number;
  /** Reserve space for the title and subtitle under each card. */
  withLabels?: boolean;
  style?: StyleProp<ViewStyle>;
}> = ({ kind, count = 5, withLabels = false, style }) => {
  const layout = useCardLayout(kind);
  const { gutter } = useBreakpoint();

  return (
    <View
      accessibilityRole='progressbar'
      accessibilityLabel='Loading'
      style={[
        {
          flexDirection: "row",
          gap: layout.spacing,
          paddingHorizontal: gutter,
          paddingVertical: layout.verticalPadding,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {indices(count).map((index) => (
        <View key={index} style={{ width: layout.cardWidth }}>
          <Skeleton
            width={layout.cardWidth}
            height={Math.round(layout.cardWidth / layout.aspectRatio)}
            radius={layout.cornerRadius}
          />
          {withLabels ? <SkeletonLabels /> : null}
        </View>
      ))}
    </View>
  );
};

/**
 * A grid of card-shaped skeletons. `columns` should be whatever `useCardGrid`
 * is about to compute for the real data — hand it the same number, or the grid
 * reflows the moment the items land.
 */
export const SkeletonGrid: React.FC<{
  kind: CardKind;
  columns: number;
  /** Rows to draw. Enough to fill a viewport is the point, not accuracy. */
  rows?: number;
  withLabels?: boolean;
  style?: StyleProp<ViewStyle>;
}> = ({ kind, columns, rows = 3, withLabels = true, style }) => {
  const layout = useCardLayout(kind);
  const { gutter } = useBreakpoint();
  const safeColumns = Math.max(1, Math.floor(columns) || 1);

  return (
    <View
      accessibilityRole='progressbar'
      accessibilityLabel='Loading'
      style={[
        {
          flexDirection: "row",
          flexWrap: "wrap",
          paddingHorizontal: gutter,
          paddingVertical: layout.verticalPadding,
        },
        style,
      ]}
    >
      {indices(safeColumns * rows).map((index) => (
        <View
          key={index}
          style={{
            // Percentage width rather than the card's own, so the grid matches
            // whatever `useCardGrid` derived from the container.
            width: `${100 / safeColumns}%`,
            maxWidth: `${100 / safeColumns}%`,
            flexGrow: 0,
            flexShrink: 0,
            // The gap lives *inside* the cell, not on the wrapper: with
            // `gap` on a wrap container, N cells of 100/N% plus N-1 gaps is
            // wider than the row, so the last column wraps and a three-column
            // grid draws a two-column skeleton — the reflow this is here to
            // prevent.
            paddingRight:
              index % safeColumns === safeColumns - 1 ? 0 : layout.spacing,
            paddingBottom: layout.spacing,
          }}
        >
          <Skeleton
            height={Math.round(layout.cardWidth / layout.aspectRatio)}
            radius={layout.cornerRadius}
          />
          {withLabels ? <SkeletonLabels /> : null}
        </View>
      ))}
    </View>
  );
};

/** A stack of text lines — a paragraph, an overview, a details block. */
export const SkeletonText: React.FC<{
  lines?: number;
  /** The last line is short, the way a paragraph's last line is. */
  lastLineWidth?: `${number}%`;
  style?: StyleProp<ViewStyle>;
}> = ({ lines = 3, lastLineWidth = "60%", style }) => (
  <View
    accessibilityRole='progressbar'
    accessibilityLabel='Loading'
    style={style}
  >
    {indices(lines).map((index) => (
      <Skeleton
        key={index}
        height={12}
        radius={4}
        width={index === lines - 1 ? lastLineWidth : "100%"}
        style={{ marginTop: index === 0 ? 0 : 8 }}
      />
    ))}
  </View>
);

const SkeletonLabels = () => (
  <>
    <Skeleton height={12} radius={4} width='85%' style={{ marginTop: 8 }} />
    <Skeleton height={10} radius={4} width='55%' style={{ marginTop: 6 }} />
  </>
);

const indices = (count: number) =>
  Array.from({ length: Math.max(0, count) }, (_, index) => index);

/**
 * The pulse, held still when the platform asks for reduced motion.
 *
 * That is not only an accessibility setting: the screenshot sweep runs its
 * contexts with reduced motion precisely so a looping animation cannot make two
 * runs of the same screen differ.
 */
const usePulse = () => {
  const opacity = useRef(new Animated.Value(1)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReduceMotion(enabled);
      })
      .catch(() => {
        /* Not every platform implements it; a still skeleton is the safe miss. */
      });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    const half = interaction.skeletonPulse / 2;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: interaction.skeletonMinOpacity,
          duration: half,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: half,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reduceMotion]);

  return opacity;
};
