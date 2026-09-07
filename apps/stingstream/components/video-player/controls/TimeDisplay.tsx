import type { FC } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Text } from "@/components/common/Text";
import { formatTimeString } from "@/utils/time";

interface TimeDisplayProps {
  currentTime: number;
  remainingTime: number;
}

/**
 * Elapsed on the left, remaining and "Ends at" on the right. The player's clock is milliseconds.
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
        {formatTimeString(currentTime, "ms")}
      </Text>
      <View style={styles.right}>
        <Text variant='caption' tone='secondary'>
          -{formatTimeString(remainingTime, "ms")}
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
