import { Ionicons } from "@expo/vector-icons";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import React from "react";
import { useFavorite } from "@/hooks/useFavorite";
import { scaleSize } from "@/utils/scaleSize";
import { TVButton } from "./TVButton";

export interface TVFavoriteButtonProps {
  item: BaseItemDto;
  disabled?: boolean;
  /** Shared with the other buttons in its row, so the row is not ragged. */
  minHeight?: number;
}

export const TVFavoriteButton: React.FC<TVFavoriteButtonProps> = ({
  item,
  disabled,
  minHeight,
}) => {
  const { isFavorite, toggleFavorite } = useFavorite(item);

  return (
    <TVButton
      onPress={toggleFavorite}
      variant='glass'
      square
      disabled={disabled}
      minHeight={minHeight}
    >
      <Ionicons
        name={isFavorite ? "heart" : "heart-outline"}
        size={scaleSize(28)}
        color='#FFFFFF'
      />
    </TVButton>
  );
};
