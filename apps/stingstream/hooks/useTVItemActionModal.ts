import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { useSetWatched } from "@/hooks/useSetWatched";
import { canMarkWatched, isWatched, watchedToggleLabelKey } from "@/utils/watched";

/**
 * The TV long-press on a card: one choice, the watched toggle.
 *
 * `Alert.alert` is the TV's native, focus-safe dialog (it draws nothing on web, which never reaches
 * here). The work is `useSetWatched`, the same as every other surface, so a TV mark refreshes the
 * same rows and badges a phone or browser one does.
 */
export const useTVItemActionModal = () => {
  const { t } = useTranslation();
  const setWatched = useSetWatched();

  const showItemActions = useCallback(
    (item: BaseItemDto) => {
      if (!canMarkWatched(item)) return;
      const played = isWatched([item]);
      const itemTitle =
        item.Type === "Episode"
          ? `${item.SeriesName} - ${item.Name}`
          : (item.Name ?? "");

      Alert.alert(itemTitle, undefined, [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t(watchedToggleLabelKey([item])),
          onPress: () => void setWatched([item], !played),
        },
      ]);
    },
    [t, setWatched],
  );

  return { showItemActions };
};
