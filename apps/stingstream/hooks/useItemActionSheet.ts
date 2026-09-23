import { useActionSheet } from "@expo/react-native-action-sheet";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useFavorite } from "@/hooks/useFavorite";
import { useSetWatched } from "@/hooks/useSetWatched";
import { useDownload } from "@/providers/DownloadProvider";
import { useOfflineMode } from "@/providers/OfflineModeProvider";
import {
  canMarkWatched,
  isWatched,
  watchedToggleLabelKey,
} from "@/utils/watched";

/**
 * The long-press action sheet for a media item behind a `TouchableItemRouter`: the watched toggle,
 * favorite, and (offline) deleting the download. The cards in rows and grids use `ItemCardMenu`
 * instead, which is the same choices as a menu.
 *
 * Returns a function that presents the sheet and resolves once it closes. Unsupported item types
 * present nothing and resolve immediately.
 */
export function useItemActionSheet(item: BaseItemDto) {
  const { t } = useTranslation();
  const { showActionSheetWithOptions } = useActionSheet();
  const setWatched = useSetWatched();
  const { isFavorite, toggleFavorite } = useFavorite(item);
  const isOffline = useOfflineMode();
  const { deleteFile } = useDownload();

  return useCallback((): Promise<void> => {
    if (!canMarkWatched(item)) return Promise.resolve();

    const played = isWatched([item]);
    const options: string[] = [
      t(watchedToggleLabelKey([item])),
      isFavorite ? t("item.remove_favorite") : t("item.add_favorite"),
      ...(isOffline ? [t("home.downloads.delete_download")] : []),
      t("common.cancel"),
    ];
    const cancelButtonIndex = options.length - 1;
    const destructiveButtonIndex = isOffline
      ? cancelButtonIndex - 1
      : undefined;

    return new Promise<void>((resolve) => {
      showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex,
          destructiveButtonIndex,
        },
        async (selectedIndex) => {
          if (selectedIndex === 0) {
            await setWatched([item], !played);
          } else if (selectedIndex === 1) {
            toggleFavorite();
          } else if (isOffline && selectedIndex === 2 && item.Id) {
            deleteFile(item.Id);
          }
          resolve();
        },
      );
    });
  }, [
    showActionSheetWithOptions,
    isFavorite,
    setWatched,
    toggleFavorite,
    isOffline,
    deleteFile,
    item,
    t,
  ]);
}
