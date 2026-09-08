import type { FC } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Text } from "@/components/common/Text";
import { formatClock } from "./utils/formatClock";

interface TimeDisplayProps {
  currentTime: number;
  remainingTime: number;
}

/**
 * Elapsed on the left, remaining and "Ends at" on the right. The player's clock is milliseconds.
 *
 * `formatClock`, not `formatTimeString`: beside a seek bar "0m 0s / -0m 20s" reads as a
 * measurement rather than a position, and its width jumps as the words change length. See
 * `utils/formatClock.ts`.
 *
 * Inline styles, like the rest of the OSD: NativeWind v2's classes do not apply in the exported
 * web bundle, and these three readings stacked into a column instead of sitting at the two ends of
 * the seek bar.
 */
export const TimeDisplay: FC<TimeDisplayProps> = ({
  currentTime,
  remainingTime,
}) => {
  const { t } = useTranslation();

  const getFinishTime = () => {
    if (!Number.isFinite(remainingTime)) return "—";
    const now = new Date();
    const finishTime = new Date(now.getTime() + remainingTime);
    return finishTime.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  };

  return (
    <View style={styles.row}>
      <Text variant='caption' tone='secondary'>
        {formatClock(currentTime)}
      </Text>
      <View style={styles.right}>
        <Text variant='caption' tone='secondary'>
          -{formatClock(remainingTime)}
        </Text>
        <Text variant='micro' tone='tertiary'>
          {t("player.ends_at", { time: getFinishTime() })}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginTop: 8,
  },
  right: {
    flexDirection: "column",
    alignItems: "flex-end",
  },
});
