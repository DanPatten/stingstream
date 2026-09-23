import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import type React from "react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View, type ViewProps } from "react-native";
import { useMarkAsPlayed } from "@/hooks/useMarkAsPlayed";
import { useTheme } from "@/hooks/useTheme";
import { isWatched, watchedToggleLabelKey } from "@/utils/watched";
import { HeaderIcon } from "./common/HeaderIcon";
import { RoundButton } from "./RoundButton";

interface Props extends ViewProps {
  /**
   * What the check marks. Prefer the one item that holds the rest (a season rather than its
   * episodes): the server marks every episode inside it in one request.
   */
  items: BaseItemDto[];
  size?: "default" | "large";
}

/** A round watched check. Lit when everything in `items` is watched; its label says what a press does. */
export const PlayedStatus: React.FC<Props> = ({ items, ...props }) => {
  const { color } = useTheme();
  const { t } = useTranslation();
  const allPlayed = isWatched(items);
  const toggle = useMarkAsPlayed(items);
  const label = t(watchedToggleLabelKey(items));

  const handlePress = useCallback(() => {
    void toggle(!allPlayed);
  }, [allPlayed, toggle]);

  return (
    <View {...props}>
      <RoundButton
        onPress={handlePress}
        size={props.size}
        accessibilityRole='button'
        accessibilityLabel={label}
        accessibilityState={{ selected: allPlayed }}
        testID='played-status'
      >
        <HeaderIcon
          name={allPlayed ? "played" : "unplayed"}
          tintColor={allPlayed ? color.accent[500] : color.text.primary}
          size={props.size === "large" ? undefined : 18}
        />
      </RoundButton>
    </View>
  );
};
