import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import React, { useMemo } from "react";
import { Platform, View } from "react-native";
import { tokens } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";

interface ProgressBarProps {
  item: BaseItemDto;
}

/**
 * How far through an item the user is, 0-100. A live TV program has no watch
 * state, so it reports how much of its air time has elapsed instead.
 */
export const getItemProgressPercentage = (item: BaseItemDto): number => {
  if (item.Type === "Program") {
    if (!item.StartDate || !item.EndDate) {
      return 0;
    }
    const startDate = new Date(item.StartDate);
    const endDate = new Date(item.EndDate);
    const now = new Date();
    const total = endDate.getTime() - startDate.getTime();
    if (total <= 0) {
      return 0;
    }
    const elapsed = now.getTime() - startDate.getTime();
    return (elapsed / total) * 100;
  }
  return item.UserData?.PlayedPercentage || 0;
};

export const ProgressBar: React.FC<ProgressBarProps> = ({ item }) => {
  const { color } = useTheme();
  const progress = useMemo(() => getItemProgressPercentage(item), [item]);

  if (progress <= 0) {
    return null;
  }

  return (
    <>
      <View
        style={{ backgroundColor: color.bg["3"], opacity: 0.8 }}
        className='absolute bottom-0 left-0 h-1 w-full'
      />
      <View
        style={{
          width: `${progress}%`,
          // A television's progress bar is white, like the rest of its focus
          // vocabulary. See docs/conventions/tv.md.
          backgroundColor: Platform.isTV
            ? tokens.focus.tv.color
            : color.accent[500],
        }}
        className='absolute bottom-0 left-0 h-1'
      />
    </>
  );
};
