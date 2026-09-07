/**
 * The ten seconds before the next episode starts, as a ring that empties.
 *
 * A ring rather than the bar this used to be for one reason: a bar under a two-line card reads as
 * "how much of the next episode you have watched", which is the opposite of what it means. A ring
 * around a play glyph is unambiguous — it is a timer, and pressing the middle skips it.
 *
 * The fill is driven from the *media clock*, not from a timer of its own: the caller hands in a
 * shared value that already accounts for pause, seek and playback speed. See
 * `NextEpisodeCountDownButton` for why that distinction matters.
 */

import type { FC, ReactNode } from "react";
import { View } from "react-native";
import Animated, {
  type SharedValue,
  useAnimatedProps,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

interface CountdownRingProps {
  /** 0 = just appeared, 1 = about to advance. */
  progress: SharedValue<number>;
  size: number;
  strokeWidth: number;
  color: string;
  trackColor: string;
  children?: ReactNode;
}

export const CountdownRing: FC<CountdownRingProps> = ({
  progress,
  size,
  strokeWidth,
  color,
  trackColor,
  children,
}) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  const animatedProps = useAnimatedProps(() => ({
    // Offsetting the dash rather than animating the length keeps the stroke's round cap where the
    // arc actually ends, which a length animation gets wrong at both extremes.
    strokeDashoffset: circumference * (1 - progress.value),
  }));

  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Svg
        width={size}
        height={size}
        // Start the arc at twelve o'clock instead of three, where a clock starts.
        style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}
      >
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={trackColor}
          strokeWidth={strokeWidth}
          fill='none'
        />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap='round'
          fill='none'
          strokeDasharray={`${circumference} ${circumference}`}
          animatedProps={animatedProps}
        />
      </Svg>
      {children}
    </View>
  );
};
