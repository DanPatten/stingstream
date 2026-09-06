import { Ionicons } from "@expo/vector-icons";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import React from "react";
import { useMarkAsPlayed } from "@/hooks/useMarkAsPlayed";
import { scaleSize } from "@/utils/scaleSize";
import { TVButton } from "./TVButton";

export interface TVPlayedButtonProps {
  item: BaseItemDto;
  disabled?: boolean;
  /** Shared with the other buttons in its row, so the row is not ragged. */
  minHeight?: number;
}

export const TVPlayedButton: React.FC<TVPlayedButtonProps> = ({
  item,
  disabled,
  minHeight,
}) => {
  const isPlayed = item.UserData?.Played ?? false;
  const toggle = useMarkAsPlayed([item]);

  return (
    <TVButton
      onPress={() => toggle(!isPlayed)}
      variant='glass'
      square
      disabled={disabled}
      minHeight={minHeight}
    >
      <Ionicons
        name={isPlayed ? "checkmark-circle" : "checkmark-circle-outline"}
        size={scaleSize(28)}
        color='#FFFFFF'
      />
    </TVButton>
  );
};
